import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/signin');
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <span className={styles.greeting}>
          Hello, {user?.full_name || user?.email}
        </span>
        <button className={styles.logoutBtn} onClick={handleLogout}>
          Log out
        </button>
      </header>

      <main className={styles.main}>
        <h1 className={styles.heading}>Your Workspace</h1>
        <p className={styles.sub}>Start a collaborative whiteboard session with AI assistance.</p>
        <button
          className={styles.startBtn}
          onClick={() => navigate('/whiteboard')}
        >
          Start New Session
        </button>
      </main>
    </div>
  );
}
