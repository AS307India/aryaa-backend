-- CreateTable
CREATE TABLE "LocationShareSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationShareSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationShareContact" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    CONSTRAINT "LocationShareContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationShareHistory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationShareHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocationShareSession_token_key" ON "LocationShareSession"("token");

-- AddForeignKey
ALTER TABLE "LocationShareSession" ADD CONSTRAINT "LocationShareSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationShareContact" ADD CONSTRAINT "LocationShareContact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LocationShareSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationShareContact" ADD CONSTRAINT "LocationShareContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationShareHistory" ADD CONSTRAINT "LocationShareHistory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LocationShareSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
