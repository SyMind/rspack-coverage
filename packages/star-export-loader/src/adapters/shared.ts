import * as t from "@babel/types";

export function singleVariableDeclarator(statement: t.Statement): t.VariableDeclarator | undefined {
  if (!t.isVariableDeclaration(statement) || statement.declarations.length !== 1) {
    return undefined;
  }
  return statement.declarations[0];
}

export function staticPropertyName(
  property: t.ObjectProperty | t.ObjectMethod,
): string | undefined {
  if (property.computed) {
    return undefined;
  }
  if (t.isIdentifier(property.key)) {
    return property.key.name;
  }
  if (t.isStringLiteral(property.key)) {
    return property.key.value;
  }
  return undefined;
}

export function returnedIdentifier(
  value: t.ArrowFunctionExpression | t.FunctionExpression | t.ObjectMethod,
): t.Identifier | undefined {
  if (value.params.length !== 0) {
    return undefined;
  }
  if (t.isIdentifier(value.body)) {
    return value.body;
  }
  if (!t.isBlockStatement(value.body) || value.body.body.length !== 1) {
    return undefined;
  }
  const [statement] = value.body.body;
  return t.isReturnStatement(statement) && t.isIdentifier(statement.argument)
    ? statement.argument
    : undefined;
}

export function membersFromDirectObject(
  object: t.ObjectExpression,
  options: { requireNullPrototype: boolean },
): { exportedName: string; localName: string }[] | undefined {
  const members: { exportedName: string; localName: string }[] = [];
  const seen = new Set<string>();
  let hasNullPrototype = false;

  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      return undefined;
    }

    const exportedName = staticPropertyName(property);
    if (exportedName === undefined) {
      return undefined;
    }

    if (
      exportedName === "__proto__" &&
      t.isObjectProperty(property) &&
      t.isNullLiteral(property.value)
    ) {
      hasNullPrototype = true;
      continue;
    }

    let local: t.Identifier | undefined;
    if (t.isObjectProperty(property) && t.isIdentifier(property.value)) {
      local = property.value;
    } else if (t.isObjectMethod(property) && property.kind === "get") {
      local = returnedIdentifier(property);
    }

    if (!local || seen.has(exportedName)) {
      return undefined;
    }
    seen.add(exportedName);
    members.push({ exportedName, localName: local.name });
  }

  if ((options.requireNullPrototype && !hasNullPrototype) || members.length === 0) {
    return undefined;
  }
  return members;
}

export function membersFromGetterMap(
  object: t.ObjectExpression,
): { exportedName: string; localName: string }[] | undefined {
  const members: { exportedName: string; localName: string }[] = [];
  const seen = new Set<string>();

  for (const property of object.properties) {
    if (!t.isObjectProperty(property)) {
      return undefined;
    }
    const exportedName = staticPropertyName(property);
    const local =
      t.isArrowFunctionExpression(property.value) || t.isFunctionExpression(property.value)
        ? returnedIdentifier(property.value)
        : undefined;
    if (exportedName === undefined || !local || seen.has(exportedName)) {
      return undefined;
    }
    seen.add(exportedName);
    members.push({ exportedName, localName: local.name });
  }

  return members.length > 0 ? members : undefined;
}

export function isObjectMethodCall(
  expression: t.Expression | t.V8IntrinsicIdentifier,
  objectName: string,
  methodName: string,
): expression is t.MemberExpression {
  return (
    t.isMemberExpression(expression) &&
    !expression.computed &&
    t.isIdentifier(expression.object, { name: objectName }) &&
    t.isIdentifier(expression.property, { name: methodName })
  );
}
