import * as t from "@babel/types";
import type { NamespaceRuntimeAdapter, NamespaceRuntimeCandidate } from "../types.js";
import { isObjectMethodCall, membersFromDirectObject, singleVariableDeclarator } from "./shared.js";

function isModuleTagDescriptor(argument: t.CallExpression["arguments"][number]): boolean {
  if (!t.isObjectExpression(argument) || argument.properties.length !== 1) {
    return false;
  }
  const [property] = argument.properties;
  return (
    t.isObjectProperty(property) &&
    !property.computed &&
    t.isIdentifier(property.key, { name: "value" }) &&
    t.isStringLiteral(property.value, { value: "Module" })
  );
}

function rollupNamespaceObject(
  argument: t.CallExpression["arguments"][number],
): { object: t.ObjectExpression; requiredGlobals: readonly string[] } | undefined {
  if (t.isObjectExpression(argument)) {
    return { object: argument, requiredGlobals: ["Object"] };
  }
  if (
    !t.isCallExpression(argument) ||
    !isObjectMethodCall(argument.callee, "Object", "defineProperty") ||
    argument.arguments.length !== 3
  ) {
    return undefined;
  }
  const [object, tag, descriptor] = argument.arguments;
  if (
    !t.isObjectExpression(object) ||
    !t.isMemberExpression(tag) ||
    tag.computed ||
    !t.isIdentifier(tag.object, { name: "Symbol" }) ||
    !t.isIdentifier(tag.property, { name: "toStringTag" }) ||
    descriptor === undefined ||
    !isModuleTagDescriptor(descriptor)
  ) {
    return undefined;
  }
  return { object, requiredGlobals: ["Object", "Symbol"] };
}

export const rollupAdapter: NamespaceRuntimeAdapter = {
  name: "rollup",
  findCandidates({ program }): readonly NamespaceRuntimeCandidate[] {
    const candidates: NamespaceRuntimeCandidate[] = [];

    for (const statement of program.body) {
      const declarator = singleVariableDeclarator(statement);
      if (
        !declarator ||
        !t.isIdentifier(declarator.id) ||
        !t.isCallExpression(declarator.init) ||
        !isObjectMethodCall(declarator.init.callee, "Object", "freeze") ||
        declarator.init.arguments.length !== 1
      ) {
        continue;
      }

      const [argument] = declarator.init.arguments;
      if (!argument) {
        continue;
      }
      const namespaceObject = rollupNamespaceObject(argument);
      if (!namespaceObject) {
        continue;
      }
      const members = membersFromDirectObject(namespaceObject.object, {
        requireNullPrototype: true,
      });
      if (!members) {
        continue;
      }

      candidates.push({
        adapter: "rollup",
        namespaceLocal: declarator.id.name,
        declarationIdentifier: declarator.id,
        members,
        removeStatements: [statement],
        allowedNamespaceReferences: [],
        requiredUnshadowedGlobals: namespaceObject.requiredGlobals,
      });
    }

    return candidates;
  },
};
