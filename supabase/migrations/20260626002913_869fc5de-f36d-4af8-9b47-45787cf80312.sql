UPDATE public.whatsapp_operators
SET audio_enabled = true,
    ai_enabled = true,
    can_control = true,
    can_schedule = true,
    receive_alerts = true,
    can_turn_on = true,
    can_turn_off = true
WHERE role = 'super_admin';