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
        (OLD.status = 'PENDING' AND NEW.status IN ('PAID_OUT', 'FAILED')) OR
        (OLD.status = 'FAILED' AND NEW.status = 'PENDING'
          AND NEW.payout_leg IN ('VENDOR', 'INSTITUTION')
          AND NEW.payout_retry_count = OLD.payout_retry_count + 1
          AND NEW.payout_retry_count <= 5
          AND NEW.internal_reference IS DISTINCT FROM OLD.internal_reference
          AND NEW.payment_gateway_status = 'READY')
    ) THEN
        RAISE EXCEPTION 'Illegal transaction status transition: PAYOUT % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_institution_transaction_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status = NEW.status) THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('RECEIVED', 'PAID_OUT', 'FAILED')) OR
        (OLD.status = 'FAILED' AND NEW.status = 'PENDING'
          AND EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.id = NEW.counterparty_transaction_id
               AND t.type = 'PAYOUT'
               AND t.payout_leg = 'INSTITUTION'
               AND t.status = 'PENDING'
               AND t.payout_retry_count BETWEEN 1 AND 5
               AND t.payment_gateway_status = 'READY'
          ))
    ) THEN
        RAISE EXCEPTION 'Illegal institution transaction status transition: % -> %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;