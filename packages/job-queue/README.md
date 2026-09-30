# Job Queue

Optional BullMQ/Redis queue factory with bounded retention and exponential retries. Nothing is enqueued at startup. Close queues during shutdown in services that instantiate them. Consumers, idempotency, tenant quotas, distributed concurrency and the Python bridge must be implemented for the application; the Python worker is not a BullMQ consumer.
