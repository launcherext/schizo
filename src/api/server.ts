import express, { Express } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { createChildLogger } from '../utils/logger';
import { setupRoutes } from './routes';
import { setupWebSocket } from './websocket';

const logger = createChildLogger('api-server');

export class ApiServer {
  private app: Express;
  private httpServer: HttpServer;
  private io: SocketServer;
  private port: number;

  constructor(port: number = 3500) {
    this.port = port;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.setupMiddleware();
    this.setupStaticFiles();
    setupRoutes(this.app);
    setupWebSocket(this.io);
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private setupStaticFiles(): void {
    // Serve static files from the public directory
    const publicPath = path.join(__dirname, '../../public');
    this.app.use(express.static(publicPath));

    // Serve index.html for root route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        logger.info({ port: this.port }, 'API server started');
        logger.info(`Dashboard available at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close();
      this.httpServer.close(() => {
        logger.info('API server stopped');
        resolve();
      });
    });
  }

  getIO(): SocketServer {
    return this.io;
  }
}

export const apiServer = new ApiServer(3500);
