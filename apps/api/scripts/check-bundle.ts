/**
 * Guards the built bundle against a build-time value being frozen into it.
 *
 * Bun replaces the literal expression `process.env.NODE_ENV` with whatever
 * `NODE_ENV` was when the bundle was built, and `--env=disable` does not cover
 * it. Nothing fails: the image starts, serves traffic, and quietly behaves as
 * though it were the build's environment — unredacted logs, no SMTP auth,
 * development config. It is invisible in source review and in every test that
 * runs from source, so it is checked here, against the artifact that ships.
 */
import { file } from 'bun'
import path from 'node:path'

const bundles = ['dist/server.js', 'dist/migrate.js']

// What `src/config.ts` compiles to once the inlining has happened.
const INLINED_ENV = /\.default\("development"\)\.parse\("(?<value>[a-z]+)"\)/

const failures = (
  await Promise.all(
    bundles.map(async (bundle) => {
      const contents = await file(
        path.resolve(import.meta.dir, '..', bundle),
      ).text()

      const inlined = INLINED_ENV.exec(contents)

      if (!inlined?.groups) return null

      return (
        `${bundle}: NODE_ENV was inlined as "${inlined.groups['value']}" at build time. ` +
        `Use process.env['NODE_ENV'] (bracket access), not process.env.NODE_ENV.`
      )
    }),
  )
).filter((failure) => failure !== null)

if (failures.length > 0) {
  console.error(
    `Bundle check failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`,
  )
  process.exit(1)
}

console.log(`Bundle check passed (${bundles.join(', ')}).`)
