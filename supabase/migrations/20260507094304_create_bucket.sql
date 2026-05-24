-- Create the single private documents bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
	'documents',
	'documents',
	false,
	52428800,  -- 50 MB per file
	ARRAY[
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       -- .xlsx
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document'  -- .docx
	]
)
ON CONFLICT (id) DO NOTHING;

-- ─── RLS policies ────────────────────────────────────────────────────────────
--
-- Expected path layout inside the bucket:
--   {tenant_id}/invoices/{uuid}.xlsx
--   {tenant_id}/offers/{uuid}.docx
--   {tenant_id}/templates/{uuid}.xlsx
--   {tenant_id}/templates/{uuid}.docx
--
-- storage.foldername(name) returns an array of path segments, so:
--   segment [1] = tenant_id
--   segment [2] = subfolder  (invoices | offers | templates)
-- ─────────────────────────────────────────────────────────────────────────────

-- SELECT (download / list)
CREATE POLICY "documents: tenant read"
ON storage.objects FOR SELECT
TO authenticated
USING (
	bucket_id = 'documents'
	AND (storage.foldername(name))[1] = (
		SELECT id::text FROM public.businesses WHERE owner_auth_id = auth.uid()
	)
	AND (storage.foldername(name))[2] IN ('invoices', 'offers', 'templates')
);

-- INSERT (upload)
CREATE POLICY "documents: tenant insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
	bucket_id = 'documents'
	AND (storage.foldername(name))[1] = (
		SELECT id::text FROM public.businesses WHERE owner_auth_id = auth.uid()
	)
	AND (storage.foldername(name))[2] IN ('invoices', 'offers', 'templates')
);

-- UPDATE (replace file)
CREATE POLICY "documents: tenant update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
	bucket_id = 'documents'
	AND (storage.foldername(name))[1] = (
		SELECT id::text FROM public.businesses WHERE owner_auth_id = auth.uid()
	)
	AND (storage.foldername(name))[2] IN ('invoices', 'offers', 'templates')
)
WITH CHECK (
	bucket_id = 'documents'
	AND (storage.foldername(name))[1] = (
		SELECT id::text FROM public.businesses WHERE owner_auth_id = auth.uid()
	)
	AND (storage.foldername(name))[2] IN ('invoices', 'offers', 'templates')
);

-- DELETE
CREATE POLICY "documents: tenant delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
	bucket_id = 'documents'
	AND (storage.foldername(name))[1] = (
		SELECT id::text FROM public.businesses WHERE owner_auth_id = auth.uid()
	)
	AND (storage.foldername(name))[2] IN ('invoices', 'offers', 'templates')
);
