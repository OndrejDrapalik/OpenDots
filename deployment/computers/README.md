# OpenBot computer services

OpenDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

The computer service is unchanged. The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies one fail-closed patch to child environment construction: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

[e2b/build-template.mjs](e2b/build-template.mjs) builds the E2B template with the installed SDK, reading `.env` and `COMPUTER_E2B_TEMPLATE` (including version tags). [release.json](release.json) supplies the source revision and Node/Bun versions; the build injects them into [e2b/e2b.Dockerfile](e2b/e2b.Dockerfile). Playwright installs the browser matching the frozen upstream package lock. The template includes OpenBot's license, and the Node archive's license is retained. The app starts the service with its per-Dot credential at runtime.

For an upgrade, review the new upstream computer and supervisor contracts, update the release manifest and Compose pins together, and build a version tag. The deployment test fails if their source revisions drift. `node deployment/computers/e2b/build-template.mjs --check` renders and hashes the SDK template offline. Start pins the resolved build and migrates workspace/profile data into a replacement when it changes; the original remains paused as a backup. Stop does not depend on the desired template version. Verify the replacement before explicitly removing backups in E2B.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
