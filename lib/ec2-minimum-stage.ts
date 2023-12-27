#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * VPC / EC2 Instance / ECS Task Definition / ECS Service
 */
export class Ec2MinimumStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);

    const stack = new cdk.Stack(this, "Stack");

    // VPC publicサブネットのみ
    const vpc = new ec2.Vpc(stack, "Vpc", {
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: true,
        },
      ],
    });

    // VPC デフォルトSecurityGroup
    const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      stack,
      "DefaultSecurityGroup",
      vpc.vpcDefaultSecurityGroup
    );
    defaultSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    // ECS Cluster
    const cluster = new ecs.Cluster(stack, "EcsCluster", {
      vpc,
    });

    // EC2インスタンス用SecurityGroup
    const ec2SecurityGroup = new ec2.SecurityGroup(stack, "Ec2SecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });
    ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(3306)
    );

    // EC2インスタンス用ロール
    const role = new iam.Role(stack, "IamRole", {
      managedPolicies: [
        // 既存のポリシーを使用
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonEC2ContainerServiceforEC2Role"
        ),
      ],
      inlinePolicies: {
        // ECS AgentのログをCloudWatchへ
        EcsCloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogStreams",
              ],
              resources: ["arn:aws:logs:*:*:*"],
            }),
          ],
        }),
      },
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    // EC2インスタンス用ECSコンフィグ
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config`
    );

    // EC2インスタンス
    const ec2Instance = new ec2.Instance(stack, "Ec2Instance", {
      vpc,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3_AMD,
        ec2.InstanceSize.MEDIUM
      ),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(
        ecs.AmiHardwareType.STANDARD
      ),
      role,
      userData,
      securityGroup: ec2SecurityGroup,
    });

    // ECS用LogGroup
    const logGroup = new logs.LogGroup(stack, "LogGroup", {
      logGroupName: "/aws/ecs/ex-ecs-wordpress",
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ECS タスク定義
    const taskDefinition = new ecs.Ec2TaskDefinition(stack, "TaskDefinition", {
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    // MariaDB コンテナ
    const mariaDbContainer = taskDefinition.addContainer("MariaDb", {
      image: ecs.ContainerImage.fromRegistry("docker.io/bitnami/mariadb:11.1"),
      environment: {
        ALLOW_EMPTY_PASSWORD: "yes",
        MARIADB_USER: "bn_wordpress",
        MARIADB_DATABASE: "bitnami_wordpress",
      },
      portMappings: [{ hostPort: 3306, containerPort: 3306 }],
      memoryLimitMiB: 1024,
      healthCheck: { command: ["CMD-SHELL", "mariadb-admin ping"] },
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "Container", logGroup }),
    });

    // Wordpress コンテナ
    const wordpressContainer = taskDefinition.addContainer("Wordpress", {
      image: ecs.ContainerImage.fromRegistry("docker.io/bitnami/wordpress:6"),
      environment: {
        ALLOW_EMPTY_PASSWORD: "yes",
        WORDPRESS_DATABASE_HOST: ec2Instance.instancePrivateIp,
        WORDPRESS_DATABASE_PORT_NUMBER: "3306",
        WORDPRESS_DATABASE_USER: "bn_wordpress",
        WORDPRESS_DATABASE_NAME: "bitnami_wordpress",
      },
      portMappings: [{ hostPort: 80, containerPort: 8080 }],
      memoryLimitMiB: 512,
      healthCheck: { command: ["CMD-SHELL", "pgrep -c httpd"] },
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "Container", logGroup }),
    });
    wordpressContainer.addContainerDependencies({
      container: mariaDbContainer,
    });

    // ECSサービス
    // ecs.EC2Service は CapacityProvider が必要なので CfnService 使用
    new ecs.CfnService(stack, "EcsService", {
      cluster: cluster.clusterArn,
      launchType: "EC2",
      taskDefinition: taskDefinition.taskDefinitionArn,
      desiredCount: 1,
    });

    new cdk.CfnOutput(stack, "PublicDomainName", {
      value: ec2Instance.instancePublicDnsName,
    });
  }
}
