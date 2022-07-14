import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { ContainerImage, Secret, Volume } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import {
  FileSystem,
  PerformanceMode,
  ThroughputMode,
} from "aws-cdk-lib/aws-efs";
import {
  AuroraCapacityUnit,
  DatabaseClusterEngine,
  ParameterGroup,
  ServerlessCluster,
} from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

export class WordpressContainerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new Vpc(this, "vpc", {
      cidr: "10.1.0.0/16",
    });

    // Aurora MySQL のパラメータ
    const parameterGroup = new ParameterGroup(this, "ParameterGroup", {
      engine: DatabaseClusterEngine.AURORA_MYSQL,
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
    const db = new ServerlessCluster(this, "ServerlessCluster", {
      vpc,
      // engine: rds.DatabaseClusterEngine.auroraMysql({
      //   version: rds.AuroraMysqlEngineVersion.of('8.0.mysql_aurora.3.02.0'),
      // }),
      engine: DatabaseClusterEngine.AURORA_MYSQL,
      defaultDatabaseName: "wordpress",
      enableDataApi: true,
      // 自動バックアップの保持期間
      backupRetention: Duration.days(1),
      parameterGroup,
      // キャパシティ
      scaling: {
        autoPause: Duration.hours(1), // V2だったら 0 を指定するけど、現状は V1 なので1時間で自動停止
        minCapacity: AuroraCapacityUnit.ACU_1,
        maxCapacity: AuroraCapacityUnit.ACU_2,
      },
      // アンデプロイ時の処理
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const getDbSecret = (field: string): Secret =>
      Secret.fromSecretsManager(db.secret!, field);

    // EFS
    const fs = new FileSystem(this, "EFS", {
      vpc,
      performanceMode: PerformanceMode.GENERAL_PURPOSE,
      throughputMode: ThroughputMode.BURSTING,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // WordPress コンテンツ
    const volume: Volume = {
      name: "wp-content",
      efsVolumeConfiguration: {
        fileSystemId: fs.fileSystemId,
      },
    };

    // // Fargate WordPressタスク
    // const taskDefinition = new FargateTaskDefinition(this, "WordPressTask", {
    //   volumes: [volume],
    // });

    // 環境変数
    const environment = {
      WORDPRESS_DB_HOST: db.clusterEndpoint.hostname,
    };
    // ユーザ名等はSecretManagerからセット
    const secrets = {
      WORDPRESS_DB_USER: getDbSecret("username"),
      WORDPRESS_DB_PASSWORD: getDbSecret("password"),
      WORDPRESS_DB_NAME: getDbSecret("dbname"),
    };
    // ポートマッピング
    // const portMappings = [
    // { containerPort: 80, hostPort: 80, protocol: Protocol.TCP },
    // ];

    // Fargate Service
    const fargateService = new ApplicationLoadBalancedFargateService(
      this,
      "WordPressService",
      {
        vpc,
        cpu: 256,
        memoryLimitMiB: 512,
        taskImageOptions: {
          image: ContainerImage.fromRegistry("wordpress:php8.1-apache"),
          environment,
          secrets,
          containerPort: 80,
        },
        publicLoadBalancer: true,
      }
    );
    // Volumeをマウント
    fargateService.taskDefinition.addVolume(volume);
    fargateService.taskDefinition.defaultContainer?.addMountPoints({
      containerPath: "/var/www/html/wp-content",
      readOnly: false,
      sourceVolume: volume.name,
    });

    // 接続を許可
    db.connections.allowDefaultPortFrom(fargateService.service);
  }
}
