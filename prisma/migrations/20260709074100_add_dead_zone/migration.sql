-- CreateTable
CREATE TABLE "DeadZoneCheckIn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedBackAt" TIMESTAMP(3) NOT NULL,
    "gracePeriodEnd" TIMESTAMP(3) NOT NULL,
    "checkedInAt" TIMESTAMP(3),
    "lastLatitude" DOUBLE PRECISION,
    "lastLongitude" DOUBLE PRECISION,
    "lastAccuracy" DOUBLE PRECISION,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "DeadZoneCheckIn_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DeadZoneCheckIn" ADD CONSTRAINT "DeadZoneCheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
