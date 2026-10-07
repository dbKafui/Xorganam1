-- KYC documents are now served through an authenticated tenant-scoped route.
-- Keep existing document rows addressable after removing the public static mount.
UPDATE kyc_documents
   SET document_url = '/api/v1/tenants/' || tenant_id::text || '/kyc-documents/' ||
       split_part(document_url, '/', 4) || '/file'
 WHERE document_url LIKE '/kyc-uploads/%/%';
