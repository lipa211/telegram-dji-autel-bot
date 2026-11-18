-- Apply in the Supabase SQL editor before deploying the updated route.
-- Guarantee at most one active vehicle per Telegram chat.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY chat_id ORDER BY created_at DESC NULLS LAST, slot DESC, id DESC
  ) AS rn
  FROM public.cars
  WHERE is_active = true
)
UPDATE public.cars AS c
SET is_active = false
FROM ranked AS r
WHERE c.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS cars_one_active_per_chat
  ON public.cars (chat_id) WHERE is_active = true;

-- Atomic and serialized selection/addition for concurrent webhook requests.
CREATE OR REPLACE FUNCTION public.create_car_atomic(p_chat_id bigint)
RETURNS SETOF public.cars
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_slot integer;
  new_id public.cars.id%TYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(p_chat_id);
  SELECT COALESCE(MAX(c.slot), 0) + 1 INTO next_slot
  FROM public.cars AS c WHERE c.chat_id = p_chat_id;

  UPDATE public.cars SET is_active = false WHERE chat_id = p_chat_id;
  INSERT INTO public.cars (chat_id, slot, is_active)
  VALUES (p_chat_id, next_slot, true)
  RETURNING id INTO new_id;
  RETURN QUERY SELECT c.* FROM public.cars AS c WHERE c.id = new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.select_car_atomic(p_chat_id bigint, p_slot integer)
RETURNS SETOF public.cars
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  selected_id public.cars.id%TYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(p_chat_id);
  SELECT c.id INTO selected_id
  FROM public.cars AS c
  WHERE c.chat_id = p_chat_id AND c.slot = p_slot
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE public.cars SET is_active = (id = selected_id)
  WHERE chat_id = p_chat_id;
  RETURN QUERY SELECT c.* FROM public.cars AS c WHERE c.id = selected_id;
END;
$$;

-- Never allow browser/anonymous callers to select arbitrary users' cars.
REVOKE ALL ON FUNCTION public.create_car_atomic(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.select_car_atomic(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_car_atomic(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.select_car_atomic(bigint, integer) TO service_role;
