INSERT INTO public.user_roles (user_id, farm_id, role)
VALUES ('a9988fda-6d6a-4eb1-8722-dadb8dabd1a4', '3e45b5ac-856e-4d29-b3b8-4dd71f86140d', 'owner')
ON CONFLICT (user_id, farm_id, role) DO NOTHING;