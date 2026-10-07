ALTER TABLE client_document_audit_log DROP CONSTRAINT client_document_audit_log_doc_type_check;
ALTER TABLE client_document_audit_log ADD CONSTRAINT client_document_audit_log_doc_type_check
  CHECK (doc_type IN ('payment_voucher','advance_clearance','subcontractor_payment','progress_claim',
    'purchase_request','petty_cash_replenishment','user_permission','subcontractor','external_payee',
    'purchase_order','subcontract_term','goods_receipt','site_expense_submission','wht_remittance',
    'branch','department','customer'));

DROP VIEW IF EXISTS client_contract_effective_terms;
DROP VIEW IF EXISTS client_contract_current_value;
DROP TABLE IF EXISTS client_contracts;
