import fs from 'node:fs'
import ts from 'typescript'

// Exercise current source modules, without relying on generated bundle symbols.
export function loadScript(relativePath) {
  const source = fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8')
  return compileScript(source)
}

export function compileScript(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
}

export function loadDeclarations(relativePath, names) {
  const source = fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8')
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true)
  const declarations = file.statements.filter(statement => names.includes(statement.name?.text))
  if (declarations.length !== names.length) throw new Error('Missing source declaration')
  return compileScript(declarations.map(statement => statement.getText(file)).join('\n'))
}

export function loadClassMethod(relativePath, className, methodName) {
  const source = fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8')
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true)
  const declaration = file.statements.find(statement => statement.name?.text === className)
  const method = declaration?.members.find(member => member.name?.text === methodName)
  if (!method) throw new Error('Missing source method')
  return compileScript(`class TestManager { ${method.getText(file)} }`)
}
