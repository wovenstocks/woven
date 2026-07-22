# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use this repository's **Security** tab and select **Report a vulnerability** to
open a private GitHub security advisory. Include:

- affected files, contracts, or deployed addresses;
- prerequisites and a minimal reproduction;
- expected and observed behavior;
- potential impact and affected assets;
- any suggested mitigation.

Avoid interacting with real user funds, publishing proof-of-concept exploits, or
testing against production systems without explicit authorization. Maintainers
will coordinate disclosure through the private advisory.

Repository administrators must enable GitHub private vulnerability reporting
before making the repository public.

## Supported code

Security fixes target the current default branch. No deployed protocol release is
declared by this repository at this time. Historical commits and third-party
integrations may not receive fixes.

## Scope and assurance

The security-sensitive surface includes:

- Solidity contracts and deployment scripts;
- constituent validation, minting, redemption, and fee distribution;
- wallet connection, chain switching, transaction construction, and address configuration;
- build and deployment configuration.

Automated tests and static-analysis artifacts support review, but they do not
constitute an independent audit, formal verification, or guarantee of safety.
See [docs/MATURITY.md](docs/MATURITY.md) for the current evidence and remaining gates.
