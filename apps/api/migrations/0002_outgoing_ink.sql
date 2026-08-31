DROP INDEX "login_challenges_user_id_index";--> statement-breakpoint
CREATE INDEX "email_change_requests_expires_at_index" ON "email_change_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "login_challenges_expires_at_index" ON "login_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_index" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signup_challenges_expires_at_index" ON "signup_challenges" USING btree ("expires_at");--> statement-breakpoint
-- `login_challenges` may already hold more than one row per user: the previous
-- delete-then-insert could interleave with a concurrent request. Keep the
-- newest challenge for each user so the unique index below can be created.
DELETE FROM "login_challenges" a
  USING "login_challenges" b
  WHERE a."user_id" = b."user_id"
    AND (a."created_at", a."id") < (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "login_challenges_user_id_index" ON "login_challenges" USING btree ("user_id");