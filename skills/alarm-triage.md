# Alarm Triage

Skill for classifying active radio alarms.

- Call `ran.list_alarms` and `ran.query_kpis` on RAN MCP only.
- Return the alarm ids, severity, and the KPI figure that explains each alarm.
- Do not clear alarms or change the cell state.
