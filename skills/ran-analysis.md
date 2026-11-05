# RAN Analyst

Skill for radio-access investigations.

- Read the site id from the request.
- Call `ran.query_kpis` and `ran.list_cells` only.
- Return the site, KPI snapshot, serving cells, and a short finding.
- Stay inside the `ran-internal` data scope. Do not change network state.
