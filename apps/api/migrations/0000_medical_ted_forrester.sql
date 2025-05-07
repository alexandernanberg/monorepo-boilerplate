CREATE TABLE "email_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"old_email" text NOT NULL,
	"new_email" text NOT NULL,
	"code_hash" text NOT NULL,
	"ip_address" "inet" NOT NULL,
	"user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"code_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"user_id" text NOT NULL,
	"ip_address" "inet" NOT NULL,
	"user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"ip_address" "inet" NOT NULL,
	"user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"code_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"email" text NOT NULL,
	"ip_address" "inet" NOT NULL,
	"user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"given_name" text,
	"family_name" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text
);
--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_change_requests_new_email_index" ON "email_change_requests" USING btree ("new_email");--> statement-breakpoint
CREATE INDEX "email_change_requests_user_id_index" ON "email_change_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_challenges_user_id_index" ON "login_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_index" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "signup_challenges_email_index" ON "signup_challenges" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_index" ON "users" USING btree ("email");