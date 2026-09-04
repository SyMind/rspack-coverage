import * as t from "@babel/types";
import type { NamespaceRuntimeAdapter, NamespaceRuntimeCandidate } from "../types.js";
import {
  membersFromDirectObject,
  membersFromGetterMap,
  singleVariableDeclarator,
} from "./shared.js";

export const rolldownAdapter: NamespaceRuntimeAdapter = {
  name: "rolldown",
  findCandidates({ program, options }): readonly NamespaceRuntimeCandidate[] {
    const candidates: NamespaceRuntimeCandidate[] = [];

    for (const statement of program.body) {
      const declarator = singleVariableDeclarator(statement);
      if (
        !declarator ||
        !t.isIdentifier(declarator.id) ||
        !t.isCallExpression(declarator.init) ||
        !t.isIdentifier(declarator.init.callee) ||
        !options.rolldownHelperNames.has(declarator.init.callee.name) ||
        declarator.init.arguments.length !== 1
      ) {
        continue;
      }

      const [argument] = declarator.init.arguments;
      if (!t.isObjectExpression(argument)) {
        continue;
      }
      const members =
        membersFromGetterMap(argument) ??
        membersFromDirectObject(argument, { requireNullPrototype: false });
      if (!members) {
        continue;
      }

      candidates.push({
        adapter: "rolldown",
        namespaceLocal: declarator.id.name,
        declarationIdentifier: declarator.id,
        members,
        removeStatements: [statement],
        allowedNamespaceReferences: [],
      });
    }

    return candidates;
  },
};
