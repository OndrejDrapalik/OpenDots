# A computer for each Dot

OpenDots connects each specialist to its own container through [OpenBot](https://github.com/CopilotKit/OpenBot)'s computer service and supervisor. A Dot's ID determines its computer and persistent volumes. Files and browser profiles survive stop/start; they are separate from Spaces pages and CopilotKit conversation history.

The app exposes selected computer tools to the same Dot agent used by web chat, Slack, scheduled work, and voice's compute delegation. Browser, workspace-file, and shell permissions are saved per Dot and checked by the server. They start disabled. No action falls back to your host's shell or files when the computer service is unavailable.

## Start services for local development

Use a working Docker Engine with Compose v2 and BuildKit support for additional build contexts. Keep the application on Node.js 24 as described in [Setup](SETUP.md). Add two different random secrets of at least 24 characters to `.env` and set:

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots
```

Do not use the placeholder values. The supervisor token authorizes lifecycle requests. The computer token is a master used to derive a different credential for each Dot; the master stays in the application and supervisor.

Build both images before starting the supervisor:

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
npm run dev
```

The computer-image service is a build target, not a shared computer to run. The supervisor creates a container when you start a Dot's computer. In this local arrangement, each computer publishes a dynamic loopback port for the app to reach. Port 4312 is the loopback supervisor endpoint. The local control network uses a normal bridge so Docker can publish that port. The container-app overlay makes the control network internal and removes the host port; the app then connects through service DNS.

Open a Dot's **Computer** panel, enable computer access and the capabilities you want, then choose **Start**. Check its status, navigate to a page, and refresh its screen. Only grant shell access when that Dot needs to run commands.

## Run the application in containers

Configure the existing `OWNER_TOKEN` and `BROWSER_SECRET` as well as the computer secrets. Use the overlay that connects the app to the supervisor and computer network:

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml build computer-image computer-supervisor app browser
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml up -d app browser computer-supervisor
```

Here, the app addresses computers by their container names. Computers have no published host ports. The supervisor lives on a separate control network, and only the supervisor mounts the Docker socket. Neither the web app nor a Dot's computer receives that socket. Changing the namespace changes which containers and volumes are selected; keep it stable and unique for each deployment.

## Run computers on E2B sandboxes

Instead of the Docker supervisor, each Dot's computer can be an [E2B](https://e2b.dev/docs) sandbox: a dedicated Linux VM running the same pinned OpenBot computer service. The OpenDots host needs no Docker engine, and the browser, files, shell, takeover and activity features work unchanged because the app still talks to the computer service's HTTP API.

Set these values in `.env` first. Use a random `COMPUTER_TOKEN` of at least 24 characters:

```dotenv
COMPUTER_PROVIDER=e2b
E2B_API_KEY=e2b_...                 # server-only; never sent into the sandbox
COMPUTER_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots-REPLACE  # unique per deployment and workspace database
# COMPUTER_E2B_TEMPLATE=opendots-computer:v1.0.0  # namespaced names and version tags supported
# E2B_DOMAIN=                        # only for a non-default E2B cluster
```

Build the template in your E2B project, then start the app:

```sh
npm run computers:e2b:template
npm run dev
```

The build uses the installed `e2b` SDK and loads `.env`; no global CLI or separate CLI login is required. It builds `COMPUTER_E2B_TEMPLATE`, defaulting to `opendots-computer`. The SDK build script injects the pins from [deployment/computers/release.json](../deployment/computers/release.json) into [e2b/e2b.Dockerfile](../deployment/computers/e2b/e2b.Dockerfile). CI checks the Docker Compose source pin against the manifest. `COMPUTER_SUPERVISOR_URL` and `COMPUTER_SUPERVISOR_TOKEN` are unused with E2B. Node's `--env-file` does not override exported shell variables; unset stray E2B configuration before building or running.

How computers are managed:

- **Ownership and concurrency:** metadata identifies the Dot and deployment. SQLite stores the active sandbox, pinned build and paused upgrade backups. Renewable leases coordinate Start, Stop and status across agent instances and server processes sharing that database. Keep the database and namespace together when restoring or moving a deployment; independent databases must use different namespaces.
- **Private ingress:** every sandbox is created with `network.allowPublicTraffic: false`. The gateway supplies E2B's traffic access token and the derived per-Dot bearer token. Neither is returned to the browser, and both are redacted from upstream responses. The E2B traffic token stays in the gateway; only the per-Dot credential is injected into the service environment. This also protects extra ports opened by shell commands. Legacy public computers are migrated into a private sandbox on their next Start.
- **Start and credential rotation:** Start explicitly resumes a paused computer and launches its service when needed. The sandbox receives `COMPUTER_BOT_ID` and `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)`; the master token and API key remain on the server. Changing the master revokes the old service on its next status/action check and installs the new credential on Start. Restart every application process with the same configuration during rotation.
- **Stop and idle pause:** Stop sends SIGTERM and waits for the service to finish flushing Chromium profiles, then takes a filesystem-only snapshot that ends all processes. A failed graceful shutdown is reported and leaves the sandbox intact. After 15 idle minutes E2B takes a memory snapshot, preserving pending cookie writes and suspended processes. Status checks and actions count as activity; status never resumes a paused computer. Only Start resumes it. Browser session cookies still follow Chromium's normal restart behavior; persistent cookies and workspace files survive explicit Stop.
- **Template upgrades:** Start resolves the configured tag to an immutable build ID. A rebuilt tag, changed template name or legacy public sandbox triggers replacement. The old service is flushed and paused, `/workspace` and `/profiles` are streamed through the SDK into the replacement, and only a ready replacement becomes accessible. Files elsewhere in the old root filesystem are retained in the backup but are not migrated. Interrupted copies remain inaccessible and retry on Start. Stop stays available even when the desired template is missing or renamed.
- **Backups and recovery:** an upgraded source is retained paused and is never automatically deleted. The application database records backup IDs; E2B metadata also links them to the Dot. Keep the original until you have verified files and browser logins in the replacement. If legacy duplicates exist without a database binding, Start refuses to choose a dataset and Stop pauses all of them. Preserve the data you need before resolving that ambiguity. A paused sandbox is kept until explicitly killed in E2B; killing it deletes its files.
- **Isolation and policy:** the VM isolates each computer. The template's `user` account has passwordless sudo and outbound internet, so shell access grants control of that Dot's VM and its browser profiles. OpenDots permissions, audit and agent pause checks run in the gateway before forwarding actions. E2B plan runtime and storage limits apply. Volumes are not required; migration uses SDK file streams and local sandbox disks.

After a build or upgrade, test two-Dot isolation, a workspace file and persistent browser login across Stop/Start, idle pause/Start, takeover, disabled permissions and token rotation. Confirm unauthenticated requests to both the computer port and a shell-started server are rejected by E2B. The automated SDK protocol tests use a local HTTP fixture; they do not provision live E2B resources.

## Use the computer

- **Browser:** navigate and inspect the current page, including screenshots and element snapshots. Browser profiles keep cookies and logins across container restarts.
- **Take control:** pause agent input while you click, type, scroll, or press keys in the browser. Release control when done. The agent must obtain a fresh snapshot before resuming element actions.
- **Files:** list, read, and write text files in the Dot's workspace. Paths must stay relative to that workspace. These files are not automatically added to Spaces pages.
- **Terminal:** run a bounded command inside that Dot's container when shell access is enabled. Command output is displayed; execution does not run on the OpenDots host.
- **Activity:** inspect action names, who requested them, and success/failure. The audit record deliberately excludes typed values, file contents, and full commands.

Stop retains files and browser profiles. The app does not expose a destructive reset action. Stopping the supervisor does not stop its dynamically created computers; stop each Dot's computer first if you want them all offline. Compose does not own those dynamically created containers or volumes. Do not delete named workspace/profile volumes as routine cleanup.

Revoking a capability cancels the application's active request and prevents subsequent actions. Cancellation cannot undo completed side effects, and an upstream browser operation may finish after the request is cancelled. Stop the computer when you need to end all activity in its container. Activity retains the latest 1,000 completed records per Dot, plus pending requests.

The template uses standard Docker container isolation; containers share the host kernel. Shell access permits programs and network access inside the container and can read that Dot's own browser profile. Run this on infrastructure appropriate for that trust level. `COMPUTER_RUNTIME=runsc` can select an already-installed gVisor runtime; the template does not install it or claim stronger isolation by default. It does not configure a restrictive network-egress policy.

## Verify and troubleshoot

Create two Dots and enable the capabilities being tested. Write a file in the first computer, then verify that the second cannot list it. Stop/start the first and verify the file persists. Test a browser session across a restart, takeover and handback, disabled permissions, and pause behavior. Confirm that computer tools fail clearly if the service is unavailable.

A configured endpoint is not evidence that Docker successfully provisioned a computer. An unavailable status can mean the Docker daemon is down, the image was not built, credentials differ, or the app cannot reach the returned computer address. Use the local arrangement for a host-run app and the app overlay for a container-run app. Do not substitute an arbitrary returned service URL or expose the computer API directly to the internet.

The source revision and the narrow per-Dot credential patch are documented in [deployment/computers](../deployment/computers/README.md). On a master-token or image change, the supervisor replaces owned computer containers on their next ensure request, retaining their profile and workspace volumes. This ends any in-flight activity; coordinate updates with active work.

Automated tests use controlled service fixtures for policy, request, and lifecycle behavior. Live Docker, model, Slack, and voice checks must be recorded separately from those tests.
