# Releasing

The npm package, Git tag and GitHub Release use the same semver. The maintained
source is this repository; OpenCode installs the published npm artifact.

## Bootstrap

For a package that does not yet exist on npm, publish its first version from an
authenticated maintainer terminal with `npm publish --access public`, completing
the registry's 2FA flow. Then configure a GitHub Actions Trusted Publisher for:

- Repository: `nxxxsooo/opencode-plannotator-tui`
- Workflow: `publish.yml`
- Allowed action: npm publish
- Environment: blank

Keep publishing protected by 2FA and use OIDC for subsequent automated releases.
No npm token belongs in the workflow or repository. The bootstrap release is not
evidence that OIDC publication has been exercised; verify that on the next release.

## Subsequent releases

1. Review the worktree and run `npm run check` plus `npm run test:smoke` for runtime changes.
2. Bump `package.json` and `package-lock.json`, and update `CHANGELOG.md`.
3. Commit the exact release state and create its `v<version>` tag. Push the branch and tag.
4. Watch `publish.yml`. It validates the tag, runs checks and publishes through OIDC.
5. If that version already exists (for example, the bootstrap), the workflow
   compares its registry integrity with the local package before skipping the upload.
6. Verify `npm view opencode-plannotator-tui version dist-tags --json`, then create
   the matching GitHub Release with user-facing changes and install/update commands.
7. Refresh the maintainer's installation:

   ```sh
   opencode plugin update opencode-plannotator-tui@latest
   opencode plugin list
   ```

   Reopen the terminal client and smoke-test the published package, not only this checkout.

Never overwrite a published tag or version. If publication fails, diagnose the
specific surface and retry only an idempotent step. Completion requires the source,
Release, registry version and maintainer installation to agree.
