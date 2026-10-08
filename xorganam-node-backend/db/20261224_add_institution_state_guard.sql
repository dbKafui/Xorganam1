BEGIN;

CREATE OR REPLACE FUNCTION enforce_institution_transaction_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status = NEW.status) THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('RECEIVED', 'PAID_OUT', 'FAILED'))
    ) THEN
        RAISE EXCEPTION 'Illegal institution transaction status transition: % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_institution_financial_transaction_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status = NEW.status) THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('PENDING_GATEWAY', 'REJECTED')) OR
        (OLD.status = 'PENDING_GATEWAY' AND NEW.status IN ('PENDING_GATEWAY', 'POSTED', 'FAILED'))
    ) THEN
        RAISE EXCEPTION 'Illegal institution financial transaction status transition: % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_institution_transaction_status_guard ON institution_transactions;
CREATE TRIGGER trg_institution_transaction_status_guard
BEFORE UPDATE ON institution_transactions
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION enforce_institution_transaction_status_transition();

DROP TRIGGER IF EXISTS trg_institution_financial_transaction_status_guard ON institution_financial_transactions;
CREATE TRIGGER trg_institution_financial_transaction_status_guard
BEFORE UPDATE ON institution_financial_transactions
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION enforce_institution_financial_transaction_status_transition();

COMMIT;
