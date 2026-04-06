# Configuration scopes: editable by role

Derived from Unblu’s guide [Configuration property scope and the configuration cascade](https://docs.unblu.com/latest/knowledge-base/guides/conceptual/scope-configuration-cascade.html).

Machine-readable mapping (same content as the table below): [`src/app/data/unblu-scope-editors.json`](../src/app/data/unblu-scope-editors.json).

Documentation wording is mapped to these role ids: **Superadministrators** → `SUPER_ADMIN`, **technical administrators** → `TECHNICAL_ADMIN`, **administrators** → `ADMIN`. The page does not assign configuration editing in these scopes to `REGISTERED_USER` or `SUPERVISOR`.

| Scope | Editable by |
| ----- | ----------- |
| `ACCOUNT` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |
| `APIKEY` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |
| `AREA` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |
| `CONVERSATION` | `SUPER_ADMIN`, `ADMIN` |
| `CONVERSATION_TEMPLATE` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |
| `GLOBAL` | `SUPER_ADMIN` |
| `IMMUTABLE` | |
| `INGRESS` | |
| `LICENSE` | |
| `TEAM` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |
| `USER` | `SUPER_ADMIN`, `TECHNICAL_ADMIN`, `ADMIN` |

## Details from the guide

- `ACCOUNT`, `AREA`, `APIKEY`, `TEAM`, `USER`, `CONVERSATION_TEMPLATE`: Account Configuration interface; superadministrators, technical administrators, administrators.
- `CONVERSATION`: **Configure conversation** in Agent Desk; only superadministrators and administrators (technical administrators are not listed).
- `GLOBAL`: Global Configuration interface; only superadmins.
- `LICENSE` / default values: not changed through these UI roles; license constrains features.
- `IMMUTABLE`: pseudo-scope for startup-time configuration (on-premises); not described as a permission of the five named roles.
- Unblu Cloud: `IMMUTABLE` and `GLOBAL` are not available to tenants in the same way as on self-hosted (per the same page).
