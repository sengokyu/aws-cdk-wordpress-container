#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Ec2MinimumStage } from "../lib/ec2-minimum-stage";
import { FargateAuroraEfsStage } from "../lib/fargate-aurora-efs-stage";

const env = {
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new cdk.App();

// サンプル1 Ec2
new Ec2MinimumStage(app, "Ec2MinimumStage", { env });

// サンプル2 Aurora / EFS
new FargateAuroraEfsStage(app, "FargateAuroraEfsStage", { env });
