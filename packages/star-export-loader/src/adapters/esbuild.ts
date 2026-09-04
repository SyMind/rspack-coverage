import * as t from "@babel/types";
import type { NamespaceRuntimeAdapter, NamespaceRuntimeCandidate } from "../types.js";
import {
  isObjectMethodCall,
  membersFromGetterMap,
  singleVariableDeclarator,
  staticPropertyName,
} from "./shared.js";

function walk(node: t.Node, visit: (child: t.Node) => boolean | undefined): void {
  if (visit(node) === false) {
    return;
  }
  const keys = t.VISITOR_KEYS[node.type] ?? [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as t.Node, visit);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as t.Node, visit);
    }
  }
}

function definePropertyAliases(program: t.Program): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const statement of program.body) {
    if (!t.isVariableDeclaration(statement)) {
      continue;
    }
    for (const declarator of statement.declarations) {
      if (
        t.isIdentifier(declarator.id) &&
        declarator.init &&
        isObjectMethodCall(declarator.init, "Object", "defineProperty")
      ) {
        aliases.add(declarator.id.name);
      }
    }
  }
  return aliases;
}

function isDefinePropertyCall(call: t.CallExpression, aliases: ReadonlySet<string>): boolean {
  return (
    isObjectMethodCall(call.callee, "Object", "defineProperty") ||
    (t.isIdentifier(call.callee) && aliases.has(call.callee.name))
  );
}

function isStaticTrue(expression: t.Expression | t.PatternLike): boolean {
  return (
    t.isBooleanLiteral(expression, { value: true }) ||
    (t.isUnaryExpression(expression, { operator: "!" }) &&
      t.isNumericLiteral(expression.argument, { value: 0 }))
  );
}

function isCanonicalDescriptor(
  expression: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | t.JSXNamespacedName,
  allName: string,
  keyName: string,
): boolean {
  if (!t.isObjectExpression(expression)) {
    return false;
  }

  let hasGetter = false;
  let hasEnumerable = false;
  for (const property of expression.properties) {
    if (!t.isObjectProperty(property)) {
      continue;
    }
    const name = staticPropertyName(property);
    if (
      name === "get" &&
      t.isMemberExpression(property.value) &&
      property.value.computed &&
      t.isIdentifier(property.value.object, { name: allName }) &&
      t.isIdentifier(property.value.property, { name: keyName })
    ) {
      hasGetter = true;
    }
    if (name === "enumerable" && t.isExpression(property.value) && isStaticTrue(property.value)) {
      hasEnumerable = true;
    }
  }
  return hasGetter && hasEnumerable;
}

function loopKeyName(left: t.ForInStatement["left"]): string | undefined {
  if (t.isIdentifier(left)) {
    return left.name;
  }
  if (!t.isVariableDeclaration(left) || left.declarations.length !== 1) {
    return undefined;
  }
  const [declarator] = left.declarations;
  return declarator && t.isIdentifier(declarator.id) ? declarator.id.name : undefined;
}

function isCanonicalHelperFunction(
  value: t.Expression | null | undefined,
  aliases: ReadonlySet<string>,
): boolean {
  if (!t.isArrowFunctionExpression(value) && !t.isFunctionExpression(value)) {
    return false;
  }
  if (
    value.params.length !== 2 ||
    !t.isIdentifier(value.params[0]) ||
    !t.isIdentifier(value.params[1])
  ) {
    return false;
  }

  const targetName = value.params[0].name;
  const allName = value.params[1].name;
  let canonical = false;

  walk(value.body, (node) => {
    if (t.isFunction(node)) {
      return false;
    }
    if (canonical || !t.isForInStatement(node) || !t.isIdentifier(node.right, { name: allName })) {
      return;
    }
    const keyName = loopKeyName(node.left);
    if (!keyName) {
      return;
    }
    walk(node.body, (inner) => {
      if (t.isFunction(inner)) {
        return false;
      }
      if (!t.isCallExpression(inner)) {
        return;
      }
      const descriptor = inner.arguments[2];
      if (
        !canonical &&
        isDefinePropertyCall(inner, aliases) &&
        inner.arguments.length >= 3 &&
        t.isIdentifier(inner.arguments[0], { name: targetName }) &&
        t.isIdentifier(inner.arguments[1], { name: keyName }) &&
        descriptor !== undefined &&
        isCanonicalDescriptor(descriptor, allName, keyName)
      ) {
        canonical = true;
      }
      return;
    });
    return;
  });

  return canonical;
}

function canonicalHelperNames(program: t.Program): ReadonlySet<string> {
  const aliases = definePropertyAliases(program);
  const names = new Set<string>();
  for (const statement of program.body) {
    if (!t.isVariableDeclaration(statement)) {
      continue;
    }
    for (const declarator of statement.declarations) {
      if (t.isIdentifier(declarator.id) && isCanonicalHelperFunction(declarator.init, aliases)) {
        names.add(declarator.id.name);
      }
    }
  }
  return names;
}

export const esbuildAdapter: NamespaceRuntimeAdapter = {
  name: "esbuild",
  findCandidates({ program, options }): readonly NamespaceRuntimeCandidate[] {
    const emptyTargets = new Map<
      string,
      { declarationIdentifier: t.Identifier; statement: t.VariableDeclaration }
    >();
    for (const statement of program.body) {
      const declarator = singleVariableDeclarator(statement);
      if (
        declarator &&
        t.isIdentifier(declarator.id) &&
        t.isObjectExpression(declarator.init) &&
        declarator.init.properties.length === 0 &&
        t.isVariableDeclaration(statement)
      ) {
        emptyTargets.set(declarator.id.name, {
          declarationIdentifier: declarator.id,
          statement,
        });
      }
    }

    const helperNames = new Set([...options.esbuildHelperNames, ...canonicalHelperNames(program)]);
    const callsByTarget = new Map<
      string,
      {
        statement: t.ExpressionStatement;
        target: t.Identifier;
        members: { exportedName: string; localName: string }[];
      }[]
    >();

    for (const statement of program.body) {
      if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) {
        continue;
      }
      const call = statement.expression;
      if (
        !t.isIdentifier(call.callee) ||
        !helperNames.has(call.callee.name) ||
        call.arguments.length !== 2
      ) {
        continue;
      }
      const [target, map] = call.arguments;
      if (!t.isIdentifier(target) || !t.isObjectExpression(map) || !emptyTargets.has(target.name)) {
        continue;
      }
      const members = membersFromGetterMap(map);
      if (!members) {
        continue;
      }
      const calls = callsByTarget.get(target.name) ?? [];
      calls.push({ statement, target, members });
      callsByTarget.set(target.name, calls);
    }

    const candidates: NamespaceRuntimeCandidate[] = [];
    for (const [namespaceLocal, calls] of callsByTarget) {
      const declaration = emptyTargets.get(namespaceLocal);
      const call = calls[0];
      if (!declaration || !call || calls.length !== 1) {
        continue;
      }
      candidates.push({
        adapter: "esbuild",
        namespaceLocal,
        declarationIdentifier: declaration.declarationIdentifier,
        members: call.members,
        removeStatements: [declaration.statement, call.statement],
        allowedNamespaceReferences: [call.target],
      });
    }

    return candidates;
  },
};
