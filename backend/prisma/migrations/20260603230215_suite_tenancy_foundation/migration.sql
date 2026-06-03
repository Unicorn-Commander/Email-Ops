-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('VIEWER', 'MEMBER', 'MANAGER', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EmailMode" AS ENUM ('SEND', 'DRAFT');

-- CreateEnum
CREATE TYPE "EmailMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('RECEIVED', 'SENT', 'DRAFT');

-- CreateEnum
CREATE TYPE "AgentInboxState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "parentWorkspaceId" TEXT,
    "isolationMode" TEXT NOT NULL DEFAULT 'standard',
    "isolationTier" TEXT NOT NULL DEFAULT 'shared',
    "hipaaMode" BOOLEAN NOT NULL DEFAULT false,
    "gdprMode" BOOLEAN NOT NULL DEFAULT false,
    "dataResidency" TEXT DEFAULT 'us-east',
    "status" TEXT NOT NULL DEFAULT 'active',
    "entitlementCache" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "userKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("userKey","workspaceId")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "keycloakId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "jmapUrl" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "secretRef" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "postmarkLane" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxAccountId" TEXT,
    "contactId" TEXT,
    "threadId" TEXT,
    "externalSource" TEXT,
    "externalRef" TEXT,
    "mode" "EmailMode" NOT NULL DEFAULT 'SEND',
    "status" "EmailMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "direction" "EmailDirection" NOT NULL DEFAULT 'SENT',
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "preview" TEXT,
    "inReplyToThreadId" TEXT,
    "providerMessageId" TEXT,
    "actorUcUid" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inbox_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "state" "AgentInboxState" NOT NULL DEFAULT 'PENDING',
    "draftedBy" TEXT,
    "summary" TEXT,
    "reviewedByUcUid" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");

-- CreateIndex
CREATE INDEX "memberships_userKey_idx" ON "memberships"("userKey");

-- CreateIndex
CREATE INDEX "memberships_workspaceId_idx" ON "memberships"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_keycloakId_key" ON "users"("keycloakId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_keycloakId_idx" ON "users"("keycloakId");

-- CreateIndex
CREATE INDEX "mailbox_accounts_workspaceId_idx" ON "mailbox_accounts"("workspaceId");

-- CreateIndex
CREATE INDEX "mailbox_accounts_workspaceId_isDefault_idx" ON "mailbox_accounts"("workspaceId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_accounts_workspaceId_emailAddress_key" ON "mailbox_accounts"("workspaceId", "emailAddress");

-- CreateIndex
CREATE INDEX "email_messages_workspaceId_idx" ON "email_messages"("workspaceId");

-- CreateIndex
CREATE INDEX "email_messages_workspaceId_contactId_createdAt_idx" ON "email_messages"("workspaceId", "contactId", "createdAt");

-- CreateIndex
CREATE INDEX "email_messages_workspaceId_threadId_idx" ON "email_messages"("workspaceId", "threadId");

-- CreateIndex
CREATE INDEX "email_messages_workspaceId_status_idx" ON "email_messages"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_workspaceId_externalSource_externalRef_key" ON "email_messages"("workspaceId", "externalSource", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "agent_inbox_items_messageId_key" ON "agent_inbox_items"("messageId");

-- CreateIndex
CREATE INDEX "agent_inbox_items_workspaceId_idx" ON "agent_inbox_items"("workspaceId");

-- CreateIndex
CREATE INDEX "agent_inbox_items_workspaceId_state_createdAt_idx" ON "agent_inbox_items"("workspaceId", "state", "createdAt");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_accounts" ADD CONSTRAINT "mailbox_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
