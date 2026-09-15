# Release

This procedure is intended for repository owners.

1. Run `npm version <version> --no-git-tag-version` and add the release notes to `CHANGELOG.md`.
2. Commit the changes, then create and push a matching version tag such as `v0.0.3`.
3. The CI workflow runs all checks, packages the extension, publishes the VSIX to the Visual Studio Marketplace, and creates a GitHub Release with the VSIX attached and generated release notes.

Before pushing a release tag, add a repository Actions secret named `VSCE_PAT`. Its value must be an Azure DevOps personal access token authorized to publish extensions for the Marketplace publisher.

The tag must exactly match `v` followed by the version in `package.json`; otherwise, the release job fails without creating a release.