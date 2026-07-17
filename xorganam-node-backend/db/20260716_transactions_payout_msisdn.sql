-- Optional payout destination captured at collection time.
-- If null, Collect For Me pays out to merchants.mobile_money_number.

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS payout_msisdn VARCHAR(30);
