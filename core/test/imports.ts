import ts from 'typescript';

export const COMPUTED = '<вычисляемый путь>';

export interface Use {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly line: number;
}

/** Все формы: `import`, `export … from`, `import()`, `require`, `import type`, `import('…').T`; вычисляемый путь - отдельной записью. */
export function usesOf(file: string, text: string): Use[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const uses: Use[] = [];
  const add = (node: ts.Node, spec: ts.Expression | undefined, typeOnly: boolean) => {
    if (spec && ts.isStringLiteralLike(spec)) uses.push({ spec: spec.text, typeOnly, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const typeOnly = clause !== undefined && (typeKeyword(clause) || (clause.name === undefined && named !== undefined && named.length > 0 && named.every((e) => e.isTypeOnly)));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node, node.arguments[0], false);
      if (node.arguments[0] && !ts.isStringLiteralLike(node.arguments[0])) uses.push({ spec: COMPUTED, typeOnly: false, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

// ImportClause.isTypeOnly в TypeScript 6 объявлен устаревшим; слово type - первый токен клаузы.
export const typeKeyword = (node: ts.Node) => node.getFirstToken()?.kind === ts.SyntaxKind.TypeKeyword;
