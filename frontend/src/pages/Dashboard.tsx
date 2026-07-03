import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import styles from './Dashboard.module.css';

interface SavedAnimation {
  id: number;
  title: string;
  videoUrl: string;
  created_at: string;
}

interface SavedWhiteboard {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  updated_at: string;
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [animations, setAnimations] = useState<SavedAnimation[]>([]);
  const [whiteboards, setWhiteboards] = useState<SavedWhiteboard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/whiteboards/list/'),
      api.get('/manim/list/'),
    ])
      .then(([wb, anim]) => {
        if (wb.status === 'fulfilled') setWhiteboards(wb.value.data.whiteboards || []);
        if (anim.status === 'fulfilled') setAnimations(anim.value.data.animations || []);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/signin');
  };

  return (
    <div className={`${styles.container} lg-aurora`}>
      <header className={styles.header}>
        <span className={styles.greeting}>
          Hello, {user?.full_name || user?.email}
        </span>
        <button className={styles.logoutBtn} onClick={handleLogout}>
          Log out
        </button>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <h1 className={styles.heading}>Your Workspace</h1>
          <p className={styles.sub}>
            Open a whiteboard to sketch and diagram, or ask the assistant to make
            an animated video.
          </p>
          <button
            className={styles.startBtn}
            onClick={() => navigate('/whiteboard')}
          >
            Start New Session
          </button>
        </section>

        <section className={styles.library}>
          <h2 className={styles.libraryTitle}>Your Whiteboards</h2>

          {loading ? (
            <p className={styles.libraryEmpty}>Loading…</p>
          ) : whiteboards.length === 0 ? (
            <p className={styles.libraryEmpty}>
              No saved whiteboards yet. In a session, open the menu (top-left) and
              choose “Save to my account” — it’ll show up here.
            </p>
          ) : (
            <div className={styles.grid}>
              {whiteboards.map((w) => (
                <button
                  key={w.id}
                  className={`${styles.card} ${styles.cardButton}`}
                  onClick={() => navigate(`/whiteboard?session=${w.id}`)}
                  title={`Open “${w.title}”`}
                >
                  {w.thumbnailUrl ? (
                    <img
                      className={styles.cardThumb}
                      src={w.thumbnailUrl}
                      alt={w.title}
                    />
                  ) : (
                    <div className={styles.cardThumbEmpty}>Whiteboard</div>
                  )}
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>{w.title}</div>
                    <div className={styles.cardDate}>
                      {new Date(w.updated_at).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className={styles.library}>
          <h2 className={styles.libraryTitle}>Your Animations</h2>

          {loading ? (
            <p className={styles.libraryEmpty}>Loading…</p>
          ) : animations.length === 0 ? (
            <p className={styles.libraryEmpty}>
              No saved animations yet. Ask the assistant for an animated video and
              choose “Yes” to save it — it’ll show up here.
            </p>
          ) : (
            <div className={styles.grid}>
              {animations.map((a) => (
                <div key={a.id} className={styles.card}>
                  <video
                    className={styles.cardVideo}
                    src={a.videoUrl}
                    controls
                    preload="metadata"
                  />
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>{a.title}</div>
                    <div className={styles.cardDate}>
                      {new Date(a.created_at).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
