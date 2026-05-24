// Supabase service-role client for file storage operations

import { createClient } from '@supabase/supabase-js';

let supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
	throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

// Accept values copied from python env that may include /rest/v1.
supabaseUrl = supabaseUrl.replace(/\/rest\/v1\/?$/, '');

export const supabase = createClient(supabaseUrl, serviceRoleKey);
