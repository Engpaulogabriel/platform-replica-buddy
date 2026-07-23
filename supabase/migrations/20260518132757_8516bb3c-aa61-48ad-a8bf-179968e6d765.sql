
DO $$
DECLARE
  v_user_id uuid;
  v_farm_id uuid := '95da696f-06ef-4e8e-bd29-1b032762c7b0';
  v_email text := 'gfariaserodio1995@gmail.com';
  v_password text := 'Terranorte2025';
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
      v_email, crypt(v_password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Gustavo"}'::jsonb,
      now(), now(), '', '', '', ''
    );

    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', v_user_id::text, now(), now(), now());
  ELSE
    UPDATE auth.users
      SET encrypted_password = crypt(v_password, gen_salt('bf')),
          email_confirmed_at = COALESCE(email_confirmed_at, now()),
          updated_at = now()
      WHERE id = v_user_id;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, default_farm_id)
  VALUES (v_user_id, v_email, 'Gustavo', v_farm_id)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
    full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    default_farm_id = COALESCE(public.profiles.default_farm_id, EXCLUDED.default_farm_id);

  INSERT INTO public.user_roles (user_id, farm_id, role)
  VALUES (v_user_id, v_farm_id, 'owner'::app_role)
  ON CONFLICT (user_id, farm_id) DO UPDATE SET role = 'owner'::app_role;
END $$;
