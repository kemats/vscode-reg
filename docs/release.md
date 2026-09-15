# Release

This procedure is intended for repository owners.

1. Run `npm version <version> --no-git-tag-version` and add the release notes to `CHANGELOG.md`.
2. Commit the changes, then create and push a matching version tag such as `v0.0.2`.
3. The CI workflow runs all checks, packages the extension, and creates a GitHub Release with the VSIX attached and generated release notes.
4. Upload the VSIX from the GitHub Release to the Visual Studio Marketplace manually.

The tag must exactly match `v` followed by the version in `package.json`; otherwise, the release job fails without creating a release.