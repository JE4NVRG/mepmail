# @millionsend/setup

The self-hosting setup wizard source for
[MepMail](https://github.com/JE4NVRG/mepmail). This fork does not currently
publish the package to npm; `@millionsend/setup` there is the upstream package.
Run the wizard from a source checkout instead:

```sh
pnpm setup:aws            # the wizard
pnpm setup:aws --dry-run  # print the full plan, touch nothing
pnpm setup:aws teardown   # delete the AWS resources it created
pnpm setup:aws add-region us-east-1   # a further SES region on an existing install
```

On an install that is already set up, a terminal run opens on a menu of next
steps instead of walking every step again.

## What it does

The wizard detects what is already in the current directory (`.env`, a compose
file, docker) and offers only the missing pieces — every step is skippable,
and re-running is safe:

1. **env** — creates `.env` from a built-in template (no repo clone needed),
   or keeps your existing one and only fills gaps. Offers to generate
   `MASTER_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` for you, and prompts once
   for `APP_BASE_URL`.
2. **AWS** — IAM policy + `millionsend` user + access key (least-privilege
   sending); with an https `APP_BASE_URL`, also the SNS event topic and SES
   configuration set so bounces, complaints, and deliveries flow back into
   your instance. Keys are written into the same `.env`.
3. **object storage & backups** — one S3-compatible credential set (Cloudflare
   R2 works out of the box) enables team logo uploads and scheduled database
   backups. Creates (or adopts) both buckets — `millionsend-storage` and
   `millionsend-backups` by default — and writes the `S3_*` lines. Public
   access for the uploads bucket cannot be enabled over the S3 API, so it
   prints the manual R2 instruction; keep the backups bucket private.
4. **launch** — uses the root `docker-compose.yml` and runs
   `docker compose up --build -d`.

In a terminal every choice is interactive (arrow-key lists, Enter accepts the
default). Piped input still works deterministically — answers one per line;
on EOF every offer defaults to "skip", so scripted runs never create anything
by surprise.

Run it anywhere Node 18+ lives; the AWS step wants your admin AWS credentials
(laptop or server — the MillionSend server itself never needs admin
credentials) and offers `aws login`/`aws sso login`/`aws configure` when the
credential check fails on a machine with the aws CLI. Each AWS run mints a
new access key — delete stale ones in the IAM console.

Full self-hosting guide:
[self-hosting.mdx](../../apps/docs/content/docs/self-hosting.mdx).
