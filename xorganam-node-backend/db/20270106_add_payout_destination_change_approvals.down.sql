DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM merchant_payout_destination_change_requests) THEN
    RAISE EXCEPTION 'Cannot roll back payout destination approval history while requests exist.';
  END IF;
END $$;

DROP TABLE merchant_payout_destination_change_requests;
