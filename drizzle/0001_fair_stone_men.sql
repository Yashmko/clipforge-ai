CREATE TABLE `clipDrafts` (
	`id` varchar(36) NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`title` varchar(140) NOT NULL,
	`captionText` text,
	`startMs` int NOT NULL,
	`endMs` int NOT NULL,
	`aspectRatio` enum('9:16','1:1','16:9') NOT NULL DEFAULT '9:16',
	`status` enum('suggested','draft','rendering','completed','failed') NOT NULL DEFAULT 'suggested',
	`exportStorageKey` varchar(512),
	`exportUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `clipDrafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clipJobs` (
	`id` varchar(36) NOT NULL,
	`visitorId` varchar(80) NOT NULL,
	`sourceKind` enum('upload','direct_url','youtube') NOT NULL,
	`sourceUrl` text,
	`sourceName` varchar(255),
	`sourceMimeType` varchar(127),
	`sourceSizeBytes` bigint,
	`sourceStorageKey` varchar(512),
	`rightsConfirmed` boolean NOT NULL DEFAULT false,
	`status` enum('draft','queued','validating','transcribing','analyzing','ready','rendering','completed','blocked','failed') NOT NULL DEFAULT 'draft',
	`progress` int NOT NULL DEFAULT 0,
	`errorCode` varchar(64),
	`errorMessage` text,
	`transcriptText` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `clipJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `clipDrafts_job_idx` ON `clipDrafts` (`jobId`);--> statement-breakpoint
CREATE INDEX `clipJobs_visitor_created_idx` ON `clipJobs` (`visitorId`,`createdAt`);