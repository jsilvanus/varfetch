# Changesets

Every user-facing change needs a changeset: run `npm run changeset`, pick the bump (patch, minor, major while 0.x: breaking changes are minor) and describe the change. Commit the generated file with your PR.

Do not edit `version` in `package.json` or run `npm publish` by hand. On merge to `main` the Release workflow opens or updates a "Version Packages" PR; merging that PR publishes to npm.
