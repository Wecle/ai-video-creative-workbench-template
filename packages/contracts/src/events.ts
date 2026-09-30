export type DomainEvent = {
  id: string;
  type: string;
  occurredAt: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};
