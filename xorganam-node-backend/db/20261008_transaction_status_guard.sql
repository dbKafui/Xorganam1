BEGIN;

CREATE OR REPLACE FUNCTION enforce_transaction_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status = NEW.status) THEN
        RETURN NEW;
    END IF;

    IF NEW.type = 'COLLECTION' AND NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('RECEIVED', 'FAILED')) OR
        (OLD.status = 'RECEIVED' AND NEW.status = 'SWEPT_INTERNAL') OR
        (OLD.status = 'SWEPT_INTERNAL' AND NEW.status IN ('PARTIALLY_SETTLED', 'PAID_OUT')) OR
        (OLD.status = 'PARTIALLY_SETTLED' AND NEW.status = 'PAID_OUT')
    ) THEN
        RAISE EXCEPTION 'Illegal transaction status transition: COLLECTION % -> %', OLD.status, NEW.status;
    END IF;

    IF NEW.type = 'INTERNAL_TRANSFER' AND NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('SWEPT_INTERNAL', 'FAILED'))
    ) THEN
        RAISE EXCEPTION 'Illegal transaction status transition: INTERNAL_TRANSFER % -> %', OLD.status, NEW.status;
    END IF;

    IF NEW.type = 'PAYOUT' AND NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('PAID_OUT', 'FAILED'))
    ) THEN
        RAISE EXCEPTION 'Illegal transaction status transition: PAYOUT % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transaction_status_guard ON transactions;
CREATE TRIGGER trg_transaction_status_guard
BEFORE UPDATE ON transactions
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION enforce_transaction_status_transition();

COMMIT;
