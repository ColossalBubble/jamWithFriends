/* Requires */
const express = require('express');
const path = require('path');
const logger = require('morgan');
const http = require('http');
const socketIO = require('socket.io');
const shortid = require('shortid');
const bodyParser = require('body-parser');
const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const expressSession=require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
require("dotenv").config();

/* Init */
const app = express();
const server = http.createServer(app);
const io = socketIO.listen(server);

/* DB  */
const users = require('./db/connection').users;

/* Middleware */
app.use(cookieParser());
app.use(logger('dev'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const pathToStaticDir = path.resolve(__dirname, '..', 'client/public');

app.use(express.static(pathToStaticDir));
app.use(express.static(pathToStaticDir, { redirect: false }));

/* Auth */
app.use(expressSession({
  secret: process.env.sessions_secret,
  resave: true,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

const fbConfig = {
  clientID: process.env.client_Id,
  clientSecret: process.env.client_Secret,
  callbackURL: process.env.callbackURL
};

passport.use(new FacebookStrategy(fbConfig, (accessToken, refreshToken, profile, done) => {
  console.log('this is the profile', profile.id);

  users.findAll({ where: { facebookId: profile.id } })
    .then(user => {
      if (user.length > 0) {
        console.log('user already exists', user[0]);
        return done(null, user);
      } else {
        return users.create({
          userName: `${profile.name.givenName} ${profile.name.familyName}`,
          password: "N/A",
          facebookId: profile.id,
          token: accessToken,
        }).then(entry => {
          console.log('this is entry for a newly added user', entry.dataValues.id);
          console.log(entry.dataValues, ' got entered', entry);
          return done(null, entry.dataValues.id);
        });
      }
    });
}
));

// serialize and deserialize
passport.serializeUser((user, done) => {
  const final = typeof user==="number"?user:user[0].dataValues.id;
  console.log('this is the user param', user);
  console.log('serializing!!!', final);
  done(null, final);
});

passport.deserializeUser((id, done) => {
  console.log('this is id in deserialize', id);

  users.findAll({ where: { id } })
    .then(found => {
      const values = found[0].dataValues;
      console.log('Trying to "deserialize" this user', values);
      done(null, id);
    });
});

/* Sockets */
const rooms = {};
const userInstruments = {};
const listenerRooms = {};

io.on('connection', socket => {
  console.log('Socket connected with ID: ', socket.id);

  io.to(socket.id).emit('connected');

  socket.on('create room', roomId => {
    if (rooms[roomId]) {
      io.to(socket.id).emit('room name taken');
    } else {
      rooms[roomId] = [];
      io.to(socket.id).emit('room created', roomId);
      // socket.emit('give rooms', rooms);
    }
  });

  socket.on('join', room => {
    console.log(socket.id, 'joining', room);
    // does room exist?
    if (!rooms[room]) {
      io.to(socket.id).emit('invalid room');
    // is room full?
    } else if (rooms[room].length >= 4) {
      socket.emit('full', room);
    } else {
      socket.join(room);
      rooms[room].push({ peerId: socket.id.slice(2), instrument: 'piano' });
      console.log('room is', rooms[room]);

      // update createorjoin open room table
      io.emit('give rooms info', getRoomsInfo(rooms));

      // emit message to socket which just joined
      io.to(socket.id).emit('joined', JSON.stringify(rooms[room]));
      // emit message to other sockets in room
      socket.broadcast.to(room).emit('new peer');

      // socket.emit('give rooms', rooms);
      socket.on('disconnect', () => {
        const socketsInRoom = rooms[room];
        const id = socket.id.slice(2);
        let inRoom = false;
        let index;
        // check to make sure peer is in room and get index of peer
        for (let i = 0; i < socketsInRoom.length; i++) {
          if (socketsInRoom[i].peerId === id) {
            inRoom = true;
            index = i;
            break;
          }
        }
        if (inRoom) {
          console.log('disconnect', id);
          socketsInRoom.splice(index, 1);
          socket.leave(room);
          socket.broadcast.to(room).emit('remove connection', id);
        }
        // update creaorjoin open room table
        io.emit('give rooms info', getRoomsInfo(rooms));

        // give updated list of peer info
        io.to(listenerRooms[room]).emit('receive peer info', JSON.stringify(rooms[room]));
      });
    }
  });

  socket.on('exit room', data => {
    const room = rooms[data.room];
    if (room !== undefined) {
      let index;
      // check to make sure peer is in room and get index of peer
      for (let i = 0; i < room.length; i++) {
        if (room[i].peerId === data.id) {
          index = i;
          break;
        }
      }
      console.log('exit room', data);
      room.splice(index, 1);
      socket.leave(data.room);
      // socket.broadcast.to(`/#${data.id}`).emit('close');
      console.log(rooms[data.room]);
      socket.broadcast.to(data.room).emit('remove connection', data.id);
      // update creaorjoin open room table
      io.emit('give rooms info', getRoomsInfo(rooms));

      // give updated list of peer info
      io.to(listenerRooms[data.room]).emit('receive peer info', JSON.stringify(room));
      // disconnect socket, client will create new socket when it starts
      // peer connection process again
      socket.disconnect(0);
    }
  });

  socket.on('offer', offer => {
    io.to(`/#${offer.to}`).emit('offer', offer);
  });

  socket.on('answer', answer => {
    io.to(`/#${answer.to}`).emit('answer', answer);
  });

  socket.on('peer info', peerInfo => {
    socket.to(peerInfo.roomId).broadcast.emit('peer info', peerInfo);
  });

  socket.on('ask for peer info', info => {
    socket.to(info.roomId).broadcast.emit('ask for peer info', info);
  });

  socket.on('give peer info', info => {
    io.to(`/#${info.sendTo}`).emit('peer info', info);
  });

  socket.on('get rooms info', id => {
    // send info to populate creaorjoin open room table
    io.to(`/#${id}`).emit('give rooms info', getRoomsInfo(rooms));
  });

  socket.on('add as listener', room => {
    listenerRooms[room] = listenerRooms[room] || shortid.generate();
    socket.join(listenerRooms[room]);
  });

  socket.on('select instrument', data => {
    console.log('select instrument', data);
    const room = rooms[data.roomId];
    console.log('room is', room);
    // update instrument of user
    for (let i = 0; i < room.length; i++) {
      if (room[i].peerId === data.id) {
        room[i].instrument = data.instrument;
        console.log('updated instrument of user', room);
        const updateRoom = JSON.stringify(room);
        io.to(listenerRooms[data.roomId]).emit('receive peer info', updateRoom);
        break;
      }
    }
    // userInstruments[data.id] = data.instrument;
  });

  socket.on('request peer info', data => {
    console.log('request peer info', data);
    console.log('room is', rooms[data.roomId]);
    console.log('socket id here', socket.id, 'got id', data.socketId);
    io.to(`/#${data.socketId}`).emit('receive peer info', JSON.stringify(rooms[data.roomId]));
  });

  socket.on('instrument select', data => {
    const room = rooms[data.roomId];
    for (let i = 0; i < room.length; i++) {
      if (room[i].peerId === data.peerId) {
        room[i].instrument = data.instrument;
        break;
      }
    }
    // update creaorjoin open room table
    io.emit('give rooms info', getRoomsInfo(rooms));
  });

  function getRoomsInfo(roomObj) {
    const roomNames = Object.keys(roomObj);
    const container = [];
    for (let i = 0; i < roomNames.length; i++) {
      container.push({
        roomName: roomNames[i],
        numPeople: roomObj[roomNames[i]].length,
        instruments: roomObj[roomNames[i]].map(peer => peer.instrument),
      });
    }
    return container;
  }
});

/* Routes */
app.get('/logout', (req, res) => {
  console.log('mysession', req.session);

  if (req.session.userName) {
    delete req.session.userName;
  }

  req.logout();

  console.log('mysession after logout', req.session);
  res.sendStatus(200);
});

app.post('/login', (req, res) => {
  console.log('req.body.pass', req.body.pass);

  users.findAll({ where: { userName: req.body.user } })
    .then(person => {
      console.log(person[0].dataValues.salt, 'person salt');
      const hash = bcrypt.hashSync(req.body.pass, person[0].dataValues.salt);
      console.log('this is the hash', hash);

      users.findAll({
        where: {
          userName: req.body.user,
          password: hash
        }
      })
        .then(user => {
          if (user.length > 0) {
            console.log("succ logged in");
            req.session.userName = req.body.user;
            res.send("Succ");
          } else {
            console.log('BadLogin');
            console.log('req.session', req.session);
            res.send("BadLogin");
          }
        });
    });
});

app.post('/signup', (req, res) => {
  users.findAll({
    where: {
      userName: req.body.user
    }
  }).then(user => {
    if (user.length > 0) {
      console.log('this is req.sesion', req.session);
      res.send('UserAlreadyExists');
    } else {
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(req.body.pass, salt);
      users.create({
        userName: req.body.user,
        password: hash,
        salt,
      }).then(entry => {
        console.log(entry.dataValues, ' got entered');
        req.session.userName = req.body.user;
        res.send('SuccessSignup');
      });
    }
  });
});

app.get('/MakeInstrument', (req, res) => {
  console.log("youre trying to access make Instrument!!!");

  if (!req.session.userName&&!req.session.passport) {
    res.redirect("/login");
  } else {
    console.log("Do nothing");
  }
});

app.get('/auth/facebook', passport.authenticate('facebook'));

app.get('/auth/facebook/callback',
  passport.authenticate('facebook', {
    successReturnToOrRedirect: '/',
    failureRedirect: '/login'
  })
);

app.get("/fbLoggedIn?", (req, res) => {
  console.log(req.session.passport);
  res.send(req.session.passport ? "true" : "false");
});

app.get('*', (req, res) => {
  console.log('req.session', req.session);
  const pathToIndex = path.join(pathToStaticDir, 'index.html');
  res.status(200).sendFile(pathToIndex);
});

/* Kick off server */
const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log('Listening on port', port);
});
