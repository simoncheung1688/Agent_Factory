/**
 * In-memory trail returned to the portal for the run that just finished.
 * Durable audit rows go to PostgreSQL through EventLogger, not through this log.
 */
export class EventLog {
  constructor() {
    this.events = [];
  }

  record(event) {
    const entry = {
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      ...event,
    };
    this.events.push(entry);
    return entry;
  }

  list() {
    return this.events.map((event) => ({ ...event }));
  }
}
