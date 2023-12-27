import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

const availabilityZone = "ap-northeast-1a";
const volumeName = "wp-content";

export class WordpressContainerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, "Vpc", {
      cidr: "10.1.0.0/16",
      subnetConfiguration: [
        { name: "Public0", subnetType: ec2.SubnetType.PUBLIC },
        {
          name: "Private0",
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
      ],
    });
    // Fargate用サブネット
    const subnet0 = vpc.privateSubnets[0];

    // Aurora MySQL のパラメータ
    const parameterGroup = new rds.ParameterGroup(this, "ParameterGroup", {
      engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
      parameters: {
        // 文字コードの構成：UTF-8 の 4 バイト文字を有効化
        character_set_client: "utf8mb4",
        character_set_connection: "utf8mb4",
        character_set_database: "utf8mb4",
        character_set_results: "utf8mb4",
        character_set_server: "utf8mb4",
        collation_connection: "utf8mb4_bin",
        collation_server: "utf8mb4_bin",
        // 一般ログの構成
        // general_log: "1", // 一般ログを有効化（既定値：0）
        // スロークエリログの構成
        // @see https://dev.mysql.com/doc/refman/8.0/ja/slow-query-log.html
        // log_queries_not_using_indexes: '1',
        // log_output: 'TABLE',
        // long_query_time: "3", // 指定時間（秒）を超えるクエリをログ出力（既定値:10秒）
        // slow_query_log: "1", // スロークエリログを有効化（既定値：0）
        // 監査ログの構成
        // server_audit_events:
        //   "CONNECT,QUERY,QUERY_DCL,QUERY_DDL,QUERY_DML,TABLE", // 監査対象イベント（既定値：なし）
        // server_audit_logging: "1", // 監査ログの有効化
        // server_audit_logs_upload: "1", // 監査ログの CloudWatch Logs へのアップロードを有効化
        // タイムゾーンの構成：日本
        time_zone: "Asia/Tokyo",
      },
    });

    // Aurora serverless V1
    const db = new rds.ServerlessCluster(this, "ServerlessCluster", {
      vpc,
      // engine: rds.DatabaseClusterEngine.auroraMysql({
      //   version: rds.AuroraMysqlEngineVersion.of('8.0.mysql_aurora.3.02.0'),
      // }),
      engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
      defaultDatabaseName: "wordpress",
      enableDataApi: true,
      // 自動バックアップの保持期間
      backupRetention: Duration.days(1),
      parameterGroup,
      // キャパシティ
      scaling: {
        autoPause: Duration.hours(1), // V2だったら 0 を指定するけど、現状は V1 なので1時間で自動停止
        minCapacity: rds.AuroraCapacityUnit.ACU_1,
        maxCapacity: rds.AuroraCapacityUnit.ACU_2,
      },
      // アンデプロイ時の処理
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const getDbSecret = (field: string): ecs.Secret =>
      ecs.Secret.fromSecretsManager(db.secret!, field);

    // ECS
    const cluster = new ecs.Cluster(this, "EcsCluster", { vpc });

    // EFS
    const fileSystem = new efs.FileSystem(this, "Efs", {
      vpc,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: RemovalPolicy.DESTROY,
      vpcSubnets: {
        subnets: [subnet0],
      },
    });
    // const mountTarget = new efs.CfnMountTarget(this, "MountTarget", {
    // fileSystemId: fileSystem.fileSystemId,
    // subnetId: subnet0.subnetId,
    // });
    const accessPoint = new efs.AccessPoint(this, "EfsAccessPoint", {
      fileSystem,
    });

    // Fargate WordPressタスク
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "WordPressTask",
      { cpu: 256, memoryLimitMiB: 512 }
    );

    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    });

    // WordPressコンテナ 環境変数
    const environment = {
      WORDPRESS_DB_HOST: db.clusterEndpoint.hostname,
    };

    // WordPressコンテナ ユーザ名等はSecretManagerからセット
    const secrets = {
      WORDPRESS_DB_USER: getDbSecret("username"),
      WORDPRESS_DB_PASSWORD: getDbSecret("password"),
      WORDPRESS_DB_NAME: getDbSecret("dbname"),
    };

    // WordPressコンテナ ポートマッピング
    const portMappings = [
      { containerPort: 80, hostPort: 80, protocol: ecs.Protocol.TCP },
    ];

    // WordPressコンテナ
    const container = new ecs.ContainerDefinition(this, "WordPressContainer", {
      image: ecs.ContainerImage.fromRegistry("wordpress:php8.1-apache"),
      taskDefinition,
      environment,
      secrets,
      portMappings,
    });

    // WordPressコンテナ Volumeをマウント
    container.addMountPoints({
      containerPath: "/var/www/html/wp-content",
      sourceVolume: volumeName,
      readOnly: false,
    });

    // ロードバランサ
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
    });
    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: true,
    });

    // Fargate Service
    const fargateService = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition,
      // 1個だけ動いていればOK
      desiredCount: 1,
      vpcSubnets: {
        subnets: [subnet0],
      },
    });

    // ECSから接続を許可
    fileSystem.connections.allowDefaultPortFrom(fargateService.connections);
    db.connections.allowDefaultPortFrom(fargateService.connections);

    // ALBへアタッチ
    listener.addTargets("ECS", {
      port: 80,
      targets: [fargateService],
    });
  }
}
