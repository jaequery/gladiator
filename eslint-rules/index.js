/**
 * Gladiator's own ESLint rules.
 *
 * Both back a convention that is otherwise only enforceable by review, and
 * review does not scale to a simulation that has to stay bit-identical in two
 * runtimes.
 */

/**
 * The `source` of an import/export node, if it is a plain string literal.
 * Returns `null` for `export const x = 1` (no source) and for
 * `import(someVariable)` (not a literal).
 */
function stringLiteral(node) {
  if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return null
  return node
}

/** Visit every module specifier in a file, however it is spelled. */
function eachSpecifier(check) {
  return {
    ImportDeclaration: (node) => check(node.source),
    ImportExpression: (node) => check(node.source),
    ExportNamedDeclaration: (node) => check(node.source),
    ExportAllDeclaration: (node) => check(node.source),
  }
}

/**
 * Forbid non-relative ("bare") module specifiers.
 *
 * `packages/sim` declares zero dependencies, so a bare specifier there does not
 * resolve at all — this rule exists to say *why* before the resolver says
 * *what*, and to catch the cross-package import (`@gladiator/client`) that
 * would otherwise resolve perfectly well and quietly couple the simulation to a
 * renderer.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noExternalImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid non-relative module specifiers, so a package can only reach code it owns.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bare:
        "gladiator: this package may not import '{{source}}'. packages/sim declares zero dependencies on purpose — it must not reach a renderer, a Node builtin, or another workspace package, because it is the one thing that has to run bit-identically in the browser and on the server. Move the code that needs '{{source}}' into the package that owns it and pass the result in.",
    },
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? [])

    return eachSpecifier((source) => {
      const literal = stringLiteral(source)
      if (literal === null) return
      if (literal.value.startsWith('.')) return
      if (allow.has(literal.value)) return
      context.report({ node: literal, messageId: 'bare', data: { source: literal.value } })
    })
  },
}

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs']

/**
 * Require the `.ts` extension on relative imports.
 *
 * `import { tick } from './step.ts'` is the only spelling simultaneously valid
 * for Vite, esbuild, `tsx` and Node's native type stripping. Extensionless
 * works in three of those four and fails in production; `./step.js`
 * type-checks and then resolves to nothing.
 *
 * Only extensionless, directory and `.js`-family specifiers are rejected — a
 * relative `./shader.glsl` or `./map.json` is left alone.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const requireTsExtension = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: { description: 'Require the .ts extension on relative import specifiers.' },
    schema: [],
    messages: {
      missing:
        "gladiator: relative import '{{source}}' must carry the '.ts' extension. That spelling is the only one Vite, esbuild, tsx and Node's native type stripping all agree on; extensionless resolves in the bundler and fails in Node.",
    },
  },
  create(context) {
    return eachSpecifier((source) => {
      const literal = stringLiteral(source)
      if (literal === null) return

      const value = literal.value
      if (!value.startsWith('.')) return

      const basename = value.split('/').pop() ?? ''
      const isDirectory = basename === '' || basename === '.' || basename === '..'
      const jsExtension = JS_EXTENSIONS.find((extension) => value.endsWith(extension))
      const isExtensionless = !isDirectory && !basename.includes('.')

      if (!isDirectory && jsExtension === undefined && !isExtensionless) return

      // A directory import has no single obvious rewrite — say so, don't guess.
      const fixed = isDirectory
        ? null
        : jsExtension === undefined
          ? `${value}.ts`
          : `${value.slice(0, -jsExtension.length)}.ts`

      context.report({
        node: literal,
        messageId: 'missing',
        data: { source: value },
        fix:
          fixed === null
            ? null
            : (fixer) => {
                const quote = literal.raw.slice(-1)
                return fixer.replaceText(literal, `${quote}${fixed}${quote}`)
              },
      })
    })
  },
}

/** @type {import('eslint').ESLint.Plugin} */
export const gladiatorPlugin = {
  meta: { name: 'eslint-plugin-gladiator', version: '0.0.0' },
  rules: {
    'no-external-import': noExternalImport,
    'require-ts-extension': requireTsExtension,
  },
}

export default gladiatorPlugin
