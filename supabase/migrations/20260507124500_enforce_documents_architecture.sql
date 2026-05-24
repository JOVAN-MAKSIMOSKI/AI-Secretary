-- Tighten storage RLS for documents bucket to enforce exact object layout.
-- Allowed object keys:
--   {tenant_id}/invoices/{uuid}.xlsx
--   {tenant_id}/offers/{uuid}.docx
--   {tenant_id}/templates/{uuid}.xlsx
--   {tenant_id}/templates/{uuid}.docx

DROP POLICY IF EXISTS "documents: tenant read" ON storage.objects;
DROP POLICY IF EXISTS "documents: tenant insert" ON storage.objects;
DROP POLICY IF EXISTS "documents: tenant update" ON storage.objects;
DROP POLICY IF EXISTS "documents: tenant delete" ON storage.objects;

CREATE POLICY "documents: tenant read"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 2
  AND (storage.foldername(name))[1] = (
    SELECT id::text
    FROM public.businesses
    WHERE owner_auth_id = auth.uid()
  )
  AND (
    ((storage.foldername(name))[2] = 'invoices' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.xlsx$')
    OR ((storage.foldername(name))[2] = 'offers' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.docx$')
    OR ((storage.foldername(name))[2] = 'templates' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(xlsx|docx)$')
  )
);

CREATE POLICY "documents: tenant insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 2
  AND (storage.foldername(name))[1] = (
    SELECT id::text
    FROM public.businesses
    WHERE owner_auth_id = auth.uid()
  )
  AND (
    ((storage.foldername(name))[2] = 'invoices' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.xlsx$')
    OR ((storage.foldername(name))[2] = 'offers' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.docx$')
    OR ((storage.foldername(name))[2] = 'templates' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(xlsx|docx)$')
  )
);

CREATE POLICY "documents: tenant update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 2
  AND (storage.foldername(name))[1] = (
    SELECT id::text
    FROM public.businesses
    WHERE owner_auth_id = auth.uid()
  )
  AND (
    ((storage.foldername(name))[2] = 'invoices' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.xlsx$')
    OR ((storage.foldername(name))[2] = 'offers' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.docx$')
    OR ((storage.foldername(name))[2] = 'templates' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(xlsx|docx)$')
  )
)
WITH CHECK (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 2
  AND (storage.foldername(name))[1] = (
    SELECT id::text
    FROM public.businesses
    WHERE owner_auth_id = auth.uid()
  )
  AND (
    ((storage.foldername(name))[2] = 'invoices' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.xlsx$')
    OR ((storage.foldername(name))[2] = 'offers' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.docx$')
    OR ((storage.foldername(name))[2] = 'templates' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(xlsx|docx)$')
  )
);

CREATE POLICY "documents: tenant delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 2
  AND (storage.foldername(name))[1] = (
    SELECT id::text
    FROM public.businesses
    WHERE owner_auth_id = auth.uid()
  )
  AND (
    ((storage.foldername(name))[2] = 'invoices' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.xlsx$')
    OR ((storage.foldername(name))[2] = 'offers' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.docx$')
    OR ((storage.foldername(name))[2] = 'templates' AND storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(xlsx|docx)$')
  )
);
