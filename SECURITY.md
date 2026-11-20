# Security Policy

Rev4a holds sensitive things: provider API keys, the dashboard password, agent
sign-ins and a terminal into every agent container. If you find a way to reach any
of them without authorization, please tell us privately first, so installs can be
fixed before the problem is public.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**
   (direct link: <https://github.com/Flame0510/rev4a/security/advisories/new>).
3. Describe the problem, the Rev4a version (`rev4a --version` or the version shown in
   the dashboard) and the steps to reproduce it. A proof of concept helps, but is not
   required.

The report stays private: only you, the repository administrators and anyone invited
to the advisory can see it. There is no security email address: GitHub's private
reporting is the only channel.

Please do not test against installs you do not own, and do not access, change or
delete other people's data while investigating.

## Supported versions

Rev4a has a single maintainer, so fixes go only into the **latest release** on npm.
Older versions do not receive patches: update from the dashboard banner or with
`rev4a update` to get a fix.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Any older release | No |

## What happens after you report

- The aim is a first answer within **7 days**. Rev4a has a single maintainer, so it can
  take longer at times.
- The report is investigated. If the problem is confirmed, the fix goes into a new
  release as soon as it is ready, and you are kept informed in the private advisory
  while it is prepared.
- Once the fixed release is out, the advisory is published, with credit to you if you
  want it.

## What Rev4a protects, and what it does not

Rev4a keeps its secrets on the host it runs on, in the clear, protected by file
permissions. This is a design choice, not an oversight:

- The provider keys, the credential vault (`credentials.db`), `.env` and the other
  Rev4a files live in the data directory (`~/.config/rev4a` by default). The secret
  files are readable only by the user that runs Rev4a (mode `0600`), but they are
  **not encrypted**.
- An agent receives the credentials assigned to it in the clear, inside its own
  container: it needs them to use them.
- A backup made with `scripts/backup.sh` holds every secret in the clear. Store it as
  carefully as the host itself.

Encrypting these files with a key kept on the same host would not stop anyone who can
read the data directory, because they could read the key too, and Rev4a has to restart
unattended. So: **anyone with root on the host, a shell as the Rev4a user, a copy of the
data directory or of a backup, or access to the Docker socket has every secret.** Protect
the host: SSH keys instead of passwords, only the ports you need open, and HTTPS in front
of the dashboard (see the remote access guide on
[rev4a.app](https://rev4a.app/en/docs/remote-access)).

A report that only shows "a secret is readable by someone who already has one of these
accesses" is expected behaviour. A way to *get* one of these accesses without
authorization is in scope.

## Scope

In scope: the Rev4a code in this repository and the npm package built from it. This
includes the dashboard and its login, the API routes, the provider proxy and key
vault, the container terminal, the session daemon, the agent base image built from
`agent-templates/base-image/`, and the self-update flow.

Out of scope (a problem in a dependency is better reported to its own project):

- vulnerabilities in OpenClaw itself, Docker, Node.js or other dependencies, unless
  Rev4a uses them in an unsafe way;
- problems that need an attacker who already has the dashboard password, root on the
  host or access to the Docker socket;
- problems caused only by how an operator deployed Rev4a, such as exposing it to the
  internet over plain HTTP or choosing a weak password.
