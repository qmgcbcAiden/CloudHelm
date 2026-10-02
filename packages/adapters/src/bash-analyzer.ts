import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { embeddedShell, findCommands, shellWord, wrappedCommand } from './shell-wrappers.js';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { CommandAnalysis, CommandCall, CommandAnalyzer } from '@cloudhelm/core';

const require = createRequire(import.meta.url);
const MAX_COMMAND_LENGTH = 65_536;
const MAX_NESTING = 4;

function isDynamic(node: SyntaxNode): boolean {
  if (/expansion|substitution|glob|concatenation|arithmetic/u.test(node.type)) return true;
  return node.namedChildren.some(isDynamic);
}

/** Resolve only trivially literal echo/printf substitutions; never execute shell text. */
function literalArgument(node: SyntaxNode): string {
  let source = node.text;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const visit = (child: SyntaxNode) => {
    if (child.type === 'command_substitution') {
      const match = child.text.match(/^\$\(\s*(?:echo\s+|printf\s+(?:["']?%s["']?\s+)?)(["']?)([\w/.-]+)\1\s*\)$/u);
      if (match) replacements.push({ start: child.startIndex - node.startIndex, end: child.endIndex - node.startIndex, value: match[2]! });
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  return shellWord(source);
}

function collect(node: SyntaxNode, analysis: CommandAnalysis, depth: number, parser: Parser): void {
  if (depth > MAX_NESTING) {
    analysis.hasError = true;
    return;
  }
  if (/expansion|substitution|glob|arithmetic/u.test(node.type)) analysis.hasExpansion = true;
  if (node.type === 'pipeline') analysis.hasPipeline = true;
  if (node.type === 'redirected_statement' || node.type === 'file_redirect' || node.type === 'herestring_redirect' || node.type === 'heredoc_redirect') analysis.hasRedirection = true;
  if (node.type === 'file_redirect') {
    const destination = node.childForFieldName('destination');
    if (destination && !/^\d*</u.test(node.text.trimStart())) analysis.redirectTargets.push(literalArgument(destination));
  }
  if (node.type === 'command') {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? literalArgument(nameNode) : '';
    const args = node.children.flatMap((child, index) => node.fieldNameForChild(index) === 'argument' ? [literalArgument(child)] : []);
    const call: CommandCall = {
      name,
      args,
      dynamic: !nameNode || isDynamic(nameNode) || node.namedChildren.some((child) => child.type === 'variable_assignment' || isDynamic(child)),
      redirects: node.namedChildren.some((child) => /redirect/u.test(child.type)) || node.parent?.type === 'redirected_statement'
    };
    const pending = [call];
    let wrappers = 0;
    while (pending.length) {
      const current = pending.shift()!;
      if (++wrappers > 16) { analysis.hasError = true; break; }
      analysis.calls.push(current);
      const source = embeddedShell(current);
      if (source !== undefined) {
        const nested = parser.parse(source);
        if (!nested || nested.rootNode.hasError) analysis.hasError = true;
        else collect(nested.rootNode, analysis, depth + 1, parser);
        nested?.delete();
      }
      const wrapped = wrappedCommand(current);
      if (wrapped) pending.push(wrapped);
      pending.push(...findCommands(current));
    }
  }
  for (const child of node.namedChildren) collect(child, analysis, depth, parser);
}

export class BashAnalyzer implements CommandAnalyzer {
  private parser: Parser | null = null;
  private initializing: Promise<Parser> | null = null;

  private async getParser(): Promise<Parser> {
    if (this.parser) return this.parser;
    if (!this.initializing) {
      this.initializing = (async () => {
        await Parser.init();
        const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
        const bundledGrammar = resourcesPath && path.join(resourcesPath, 'tree-sitter-bash.wasm');
        const grammarPath = bundledGrammar && existsSync(bundledGrammar)
          ? bundledGrammar : path.join(path.dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm');
        const grammar = await Language.load(grammarPath);
        const parser = new Parser().setLanguage(grammar);
        this.parser = parser;
        return parser;
      })();
    }
    return this.initializing;
  }

  async analyze(command: string): Promise<CommandAnalysis> {
    const analysis: CommandAnalysis = {
      calls: [], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: command.length > MAX_COMMAND_LENGTH || command.includes('\u0000'), raw: command
    };
    if (analysis.hasError) return analysis;
    const parser = await this.getParser();
    const tree = parser.parse(command);
    if (!tree) return { ...analysis, hasError: true };
    try {
      analysis.hasError = tree.rootNode.hasError;
      analysis.hasCompound = tree.rootNode.namedChildren.length !== 1
        || tree.rootNode.namedChildren.some((node) => node.type !== 'command')
        || tree.rootNode.children.some((node) => ['&', ';', '&&', '||'].includes(node.type));
      collect(tree.rootNode, analysis, 0, parser);
      if (analysis.calls.length > 1) analysis.hasCompound = true;
      return analysis;
    } finally {
      tree.delete();
    }
  }
}
