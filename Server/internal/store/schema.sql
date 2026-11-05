-- Applied by store.Migrate on every start, so every statement must be safe to run again.

CREATE TABLE IF NOT EXISTS users (
    username               text PRIMARY KEY,
    password_hash          text NOT NULL,
    roles                  text[] NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL,
    refresh_tokens         jsonb NOT NULL DEFAULT '[]',
    spent_refresh_tokens   jsonb NOT NULL DEFAULT '[]',
    ai_call_count_in_round integer NOT NULL DEFAULT 0,
    start_round_time       timestamptz,
    version                bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS users_refresh_tokens ON users USING gin (refresh_tokens jsonb_path_ops);
CREATE INDEX IF NOT EXISTS users_spent_refresh_tokens ON users USING gin (spent_refresh_tokens jsonb_path_ops);

CREATE TABLE IF NOT EXISTS jobs (
    id                  text PRIMARY KEY,
    username            text NOT NULL,
    status              text NOT NULL,
    title               text NOT NULL,
    creative            boolean NOT NULL,
    language            integer NOT NULL DEFAULT 0,
    export_type         integer,
    intelligence        integer NOT NULL DEFAULT 0,
    image_count         integer NOT NULL DEFAULT 0,
    course_type         integer,
    course_name         text NOT NULL DEFAULT '',
    hsk_standard        integer,
    level               integer,
    lesson_numbers      integer[],
    gesture_stages      integer[],
    questions_per_stage integer,
    progress_rows       integer NOT NULL DEFAULT 0,
    csv                 text NOT NULL DEFAULT '',
    source              text NOT NULL DEFAULT '',
    error_status        integer NOT NULL DEFAULT 0,
    error_code          text NOT NULL DEFAULT '',
    error_message       text NOT NULL DEFAULT '',
    usage               jsonb,
    round_start         timestamptz NOT NULL,
    created_at          timestamptz NOT NULL,
    heartbeat_at        timestamptz,
    finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_username_created_at ON jobs (username, created_at DESC);

CREATE TABLE IF NOT EXISTS assignments (
    id            text PRIMARY KEY,
    code          text NOT NULL UNIQUE,
    username      text NOT NULL,
    job_id        text NOT NULL,
    title         text NOT NULL,
    label         text NOT NULL DEFAULT '',
    language      integer NOT NULL DEFAULT 0,
    csv           text NOT NULL DEFAULT '',
    time_mode     text NOT NULL,
    stage_lock    text NOT NULL DEFAULT '',
    stage_counts  jsonb NOT NULL DEFAULT '{}',
    pass_percents jsonb,
    max_attempts  integer,
    hide_board    boolean NOT NULL DEFAULT false,
    show_pinyin   boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL,
    closes_at     timestamptz,
    closed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS assignments_username_created_at ON assignments (username, created_at DESC);

CREATE TABLE IF NOT EXISTS assignment_players (
    id             text PRIMARY KEY,
    assignment_id  text NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
    name           text NOT NULL,
    avatar         text NOT NULL DEFAULT '',
    name_key       text NOT NULL,
    token_hash     text NOT NULL,
    joined_at      timestamptz NOT NULL,
    last_played_at timestamptz,
    stages         jsonb NOT NULL DEFAULT '{}',
    started        jsonb,
    run            jsonb,
    version        integer NOT NULL DEFAULT 0,
    UNIQUE (assignment_id, name_key)
);
CREATE INDEX IF NOT EXISTS assignment_players_token ON assignment_players (assignment_id, token_hash);
CREATE INDEX IF NOT EXISTS assignment_players_joined ON assignment_players (assignment_id, joined_at, id);

CREATE TABLE IF NOT EXISTS login_attempts (
    key          text PRIMARY KEY,
    count        integer NOT NULL,
    window_start timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_expires_at ON login_attempts (expires_at);
